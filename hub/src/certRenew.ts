// Renewal of the certificates of the agent link (homelab#302); the CA itself is not rotated.
//   - Client certificate of an agent: signed again for the key the agent presents in its mutual TLS handshake (proven
//     by it, never sent), and sent with the cert_install request. Until the agent connects with it, the hub accepts
//     both: nextCertFingerprint is then promoted and the previous certificate stops working. An agent that could not
//     write it keeps working with the previous one.
//   - Certificate of the agent port: reissued by the hub for the same key (pinned by the install commands).
import type { FastifyBaseLogger } from 'fastify';
import type { ObjectId } from 'mongodb';
import { agentRequest, isOnline, peerCertificate } from './agents.js';
import { recordAudit } from './audit.js';
import { hosts, settings } from './db.js';
import { CLIENT_CERT_DAYS, SERVER_CERT_DAYS, certNotAfter, renewServerCert, signClientKey } from './pki.js';
import { loadPki, resetPki } from './pkiStore.js';
import type { HostDoc } from './types.js';

const DAY = 24 * 3600 * 1000;
// renewed when less than this is left
export const CLIENT_RENEW_BEFORE_DAYS = 120;
export const SERVER_RENEW_BEFORE_DAYS = 180;
// a certificate expiring within this is shown as a warning (agent away too long to be renewed)
export const CERT_WARN_DAYS = 30;

// Fields of the agent certificate, dropped together with it (revocation).
export const CERT_FIELDS = { certFingerprint: '', certIssuedAt: '', certNotAfter: '', nextCertFingerprint: '', nextCertIssuedAt: '', certRenewAttemptAt: '' } as const;

/**
 * Due when little is left, or when it lasts longer than the current lifetime (certificates issued before it was
 * shortened: renewed at the first contact).
 */
export function renewalDue(notAfter: Date, lifetimeDays: number, beforeDays: number, now = Date.now()) {
  const left = notAfter.getTime() - now;
  return left < beforeDays * DAY || left > (lifetimeDays + 1) * DAY;
}

/**
 * The host whose current or renewed certificate this is; a renewed one becomes the only valid one.
 */
export async function hostByCertificate(fingerprint: string, notAfter: Date | null) {
  const host = await hosts.findOne({ $or: [{ certFingerprint: fingerprint }, { nextCertFingerprint: fingerprint }] });
  if (!host || host.certFingerprint === fingerprint) return host;
  const promoted = await hosts.findOneAndUpdate(
    { _id: host._id, nextCertFingerprint: fingerprint },
    {
      $set: { certFingerprint: fingerprint, certIssuedAt: host.nextCertIssuedAt ?? new Date(), ...(notAfter ? { certNotAfter: notAfter } : {}) },
      $unset: { nextCertFingerprint: '', nextCertIssuedAt: '' },
    },
    { returnDocument: 'after' },
  );
  if (promoted) {
    void recordAudit({
      category: 'host',
      action: 'host.certRenewed',
      actor: { kind: 'agent', name: host.name },
      target: { kind: 'host', id: host._id.toHexString(), name: host.name },
      details: { certFingerprint: fingerprint, previous: host.certFingerprint ?? null, notAfter: notAfter?.toISOString() ?? null },
    });
  }
  return promoted;
}

/** Issues a renewed certificate for an online agent and has it installed; it is used from its next connection on. */
export async function renewAgentCert(host: Pick<HostDoc, '_id' | 'name'>, log: FastifyBaseLogger, trigger: 'auto' | 'manual') {
  const id = host._id.toHexString();
  const peer = peerCertificate(id);
  if (!peer) throw new Error('hôte hors ligne');
  const { certPem, fingerprint, notAfter } = await signClientKey(await loadPki(), peer.spki, id);
  await hosts.updateOne({ _id: host._id }, { $set: { nextCertFingerprint: fingerprint, nextCertIssuedAt: new Date() } });
  await agentRequest(id, 'cert_install', { cert: certPem }, 30_000);
  log.info({ host: host.name, notAfter, trigger }, 'agent certificate renewed');
  return { notAfter };
}

/** Automatic renewal of an online agent that supports it, at most one attempt a day. */
export async function maybeRenewAgentCert(hostId: ObjectId, log: FastifyBaseLogger, now = Date.now()) {
  const id = hostId.toHexString();
  const peer = peerCertificate(id);
  if (!peer || !isOnline(id) || !renewalDue(peer.notAfter, CLIENT_CERT_DAYS, CLIENT_RENEW_BEFORE_DAYS, now)) return false;
  const host = await hosts.findOneAndUpdate(
    { _id: hostId, capabilities: 'cert_renew', $or: [{ certRenewAttemptAt: { $exists: false } }, { certRenewAttemptAt: { $lt: new Date(now - DAY) } }] },
    { $set: { certRenewAttemptAt: new Date(now) } },
  );
  if (!host) return false;
  try {
    await renewAgentCert(host, log, 'auto');
    return true;
  } catch (err) {
    log.warn({ err, host: host.name }, 'agent certificate not renewed');
    return false;
  }
}

/** Renewal of every online agent due (scheduler). */
export async function renewDueAgentCerts(log: FastifyBaseLogger) {
  for (const h of await hosts.find({ capabilities: 'cert_renew', certFingerprint: { $exists: true } }, { projection: { _id: 1 } }).toArray()) {
    await maybeRenewAgentCert(h._id, log);
  }
}

/** Reissues the certificate of the agent port when due; true when it changed (to be loaded by the TLS server). */
export async function renewServerCertIfDue(log: FastifyBaseLogger, now = Date.now()) {
  const pki = await loadPki();
  const notAfter = certNotAfter(pki.serverCert);
  if (!renewalDue(notAfter, SERVER_CERT_DAYS, SERVER_RENEW_BEFORE_DAYS, now)) return false;
  const next = await renewServerCert(pki, new Date(now));
  // two hubs on the same base: only one replaces it, the other loads the result
  const res = await settings.updateOne({ _id: 'pki', serverCert: pki.serverCert }, { $set: { serverCert: next.certPem } });
  resetPki();
  if (res.modifiedCount) log.info({ previous: notAfter, notAfter: next.notAfter }, 'certificate of the agent port renewed');
  return true;
}
