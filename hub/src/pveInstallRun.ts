import { ObjectId } from 'mongodb';
import { AgentRequestError, agentRequest, isOnline } from './agents.js';
import { guests, hosts, jobs } from './db.js';
import { publish } from './events.js';
import { createJob } from './jobs.js';
import { loadPveSettings, nodeHosts } from './pve.js';
import { checkVerdict, staticEligibility, PveInstallError, type CheckVerdict, type GuestCheck, type InstallTarget } from './pveInstall.js';
import { UNMANAGED, newEnrollCode } from './routes/hosts.js';
import type { HostDoc } from './types.js';

// Plan and run of the installation of the agent in CT from the inventory (homelab#259); the rules are in pveInstall.ts.

// --- plan and run ----------------------------------------------------------------------------------

const WATCH_MS = 15 * 60_000;

const MAX_VMIDS = 50;

export const hasAgent = (h: Pick<HostDoc, 'certFingerprint' | 'tokenHash'>) => !!(h.certFingerprint || h.tokenHash);

// Plan of the installation in the CT asked for: eligibility of each one (inventory, then what the agent of its node finds
// in the running ones), host that each would become. Reads only.
export async function planInstall(clusterId: string, vmids: number[]): Promise<InstallTarget[]> {
  if (!vmids.length || vmids.length > MAX_VMIDS) throw new PveInstallError(`entre 1 et ${MAX_VMIDS} CT`);
  const cluster = (await loadPveSettings()).clusters.find((c) => c.id === clusterId);
  if (!cluster) throw new PveInstallError('cluster introuvable', 404);
  const docs = await guests.find({ cluster: clusterId, vmid: { $in: vmids } }).toArray();
  const byVmid = new Map(docs.map((g) => [g.vmid, g]));
  const list = await hosts.find().toArray();
  const carriers = nodeHosts(cluster, [...new Set(docs.map((g) => g.node))], list);

  const targets = new Map<number, InstallTarget & { carrier: HostDoc | null; check?: CheckVerdict }>();
  for (const vmid of [...new Set(vmids)]) {
    const g = byVmid.get(vmid);
    if (!g) throw new PveInstallError(`CT ${vmid} introuvable dans l'inventaire`, 404);
    const carrier = carriers.get(g.node) ?? null;
    const linked = g.hostId ? list.find((h) => h._id.toHexString() === g.hostId) : undefined;
    const st = staticEligibility(g, carrier ? { capabilities: carrier.capabilities, online: isOnline(carrier._id.toHexString()) } : null, !!linked && hasAgent(linked));
    targets.set(vmid, {
      vmid,
      name: g.name,
      node: g.node,
      eligible: st.eligible,
      reasons: st.reasons,
      mode: null,
      hostName: linked ? linked.name : g.name || `ct-${vmid}`,
      ...(linked ? { hostId: linked._id.toHexString() } : {}),
      siteId: carrier?.siteId ?? null,
      tags: carrier?.tags ?? [],
      installCurl: false,
      carrier,
    });
  }

  // what the CT hold, node by node (the agent only reads)
  const hub = new Map<string, number[]>();
  for (const t of targets.values()) if (t.eligible && t.carrier) hub.set(t.carrier._id.toHexString(), [...(hub.get(t.carrier._id.toHexString()) ?? []), t.vmid]);
  for (const [carrierId, ids] of hub) {
    let checks: GuestCheck[] = [];
    try {
      checks = (await agentRequest<{ guests: GuestCheck[] }>(carrierId, 'pve_guest_check', { pveVmids: ids }, 20_000 + 10_000 * ids.length)).guests;
    } catch (err) {
      if (!(err instanceof AgentRequestError)) throw err;
      for (const id of ids) Object.assign(targets.get(id)!, { eligible: false, reasons: [err.message] });
      continue;
    }
    for (const id of ids) {
      const t = targets.get(id)!;
      const c = checks.find((x) => x.vmid === id);
      const v = c ? checkVerdict(c) : { eligible: false, reasons: ["pas de réponse de l'agent du nœud"], installCurl: false, relink: false };
      Object.assign(t, { eligible: v.eligible, reasons: v.reasons, installCurl: v.installCurl, check: v });
    }
  }

  // the host each one becomes
  for (const t of targets.values()) {
    if (!t.eligible) continue;
    if (t.hostId) {
      t.mode = 'reuse';
      t.reasons.push(`l'hôte « ${t.hostName} » est réutilisé (agent révoqué ou non enrôlé)`);
      continue;
    }
    const same = list.filter((h) => h.name.toLowerCase() === t.hostName.toLowerCase());
    if (t.check?.relink && same.length === 1 && !same[0].pve) {
      t.mode = 'reuse';
      t.reasons.push(`l'hôte « ${same[0].name} » est réutilisé`);
    } else {
      t.mode = 'create';
      if (same.length) t.reasons.push(`un hôte porte déjà le nom « ${t.hostName} » : un second sera créé`);
    }
  }
  return [...targets.values()].map(({ carrier: _c, check: _k, ...t }) => t);
}

// Installs the agent in each eligible CT of the plan: one job per CT, on the agent of its node. The host (created, or
// reused with a new code) is made here; if the installation fails before the agent enrolled, a created host is removed.
export async function runInstall(clusterId: string, vmids: number[]): Promise<InstallTarget[]> {
  const plan = await planInstall(clusterId, vmids);
  const cluster = (await loadPveSettings()).clusters.find((c) => c.id === clusterId)!;
  const list = await hosts.find().toArray();
  const carriers = nodeHosts(cluster, [...new Set(plan.map((t) => t.node))], list);
  for (const t of plan) {
    if (!t.eligible || !t.mode) continue;
    const carrier = carriers.get(t.node)!;
    const enroll = newEnrollCode();
    let hostId: ObjectId;
    if (t.mode === 'reuse') {
      const h = (t.hostId ? list.find((x) => x._id.toHexString() === t.hostId) : list.find((x) => x.name.toLowerCase() === t.hostName.toLowerCase()))!;
      hostId = h._id;
      // the link with the cluster is made again from the MAC addresses the agent reports once enrolled
      await hosts.updateOne({ _id: hostId }, { $set: enroll.fields, $unset: { pve: '', pveLost: '' } });
    } else {
      hostId = new ObjectId();
      const doc: HostDoc = {
        _id: hostId,
        name: t.hostName,
        siteId: t.siteId || undefined,
        tags: t.tags.length ? t.tags : undefined,
        haExcluded: carrier.haExcluded || undefined,
        ...(carrier.accessNetwork ? { accessNetwork: carrier.accessNetwork } : {}),
        setupOverrides: UNMANAGED,
        ...enroll.fields,
        createdAt: new Date(),
      };
      await hosts.insertOne(doc);
    }
    const job = await createJob(carrier, 'agent_install', [], 'manual', {
      install: { kind: 'lxc', vmid: t.vmid, code: enroll.code, installCurl: t.installCurl },
      installTarget: { cluster: clusterId, vmid: t.vmid, hostId },
    });
    t.jobId = job._id.toHexString();
    void settleInstall(job._id, hostId, t.mode === 'create');
  }
  publish('backups', {});
  return plan;
}

// Waits for the end of the job, then cleans up after a failure: a host created for it goes if no agent ever enrolled,
// the code of a reused one is withdrawn.
export async function settleInstall(jobId: ObjectId, hostId: ObjectId, created: boolean) {
  const deadline = Date.now() + WATCH_MS;
  for (;;) {
    const job = await jobs.findOne({ _id: jobId }, { projection: { status: 1 } });
    if (job && job.status !== 'running') {
      if (job.status === 'failed') await cleanupFailedInstall(hostId, created);
      publish('backups', {});
      return;
    }
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function cleanupFailedInstall(hostId: ObjectId, created: boolean) {
  const h = await hosts.findOne({ _id: hostId });
  if (!h) return;
  if (created && !h.certFingerprint) {
    await hosts.deleteOne({ _id: hostId });
    publish('host.deleted', { id: hostId.toHexString() });
  } else {
    await hosts.updateOne({ _id: hostId }, { $unset: { enrollCodeHash: '', enrollExpiresAt: '' } });
  }
}
