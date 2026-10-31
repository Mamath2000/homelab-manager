import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plug, Save } from 'lucide-react';
import { api, type PveCluster, type PveClusterInput, type PveDetected } from '../lib/api';
import { useHosts } from '../lib/queries';
import { stepStates } from '../lib/steps';
import { useToast } from '../lib/toast';
import { AgentPicker, TokenButton } from './AgentPicker';
import { CheckLine, DetectedRows, Step, Steps, type CheckState } from './PbsDialog';
import { field } from './ProxmoxServer';
import { useSettingsDraft } from './settingsDraft';
import { Button, ConfirmModal, Modal } from './ui';

const DEFAULT_TOKEN = 'homelab@pve!monitor';
const PORT = 8006;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 32);
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// Corosync cluster of a node, announced by its agent (`pve_cluster:<name>`).
const clusterOf = (caps: string[]) => caps.find((c) => c.startsWith('pve_cluster:'))?.slice('pve_cluster:'.length);

// One cluster (a pve-cluster role of the hub, Paramètres › Rôles), declared from one of its nodes in four steps
// (PbsDialog.tsx): node and Détecter, what its agent found and the interface the hub reaches the API at, token created
// by the agent, test. Choosing another node of the cluster moves the role. The secret is never sent back by the hub.
export function ClusterModal({ cluster, others, onClose }: { cluster: PveCluster | null; others: PveCluster[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: hosts } = useHosts();
  // nodes of the clusters already followed are not offered again (the hub refuses them as well)
  const followed = new Set(others.flatMap((c) => clusterOf(hosts?.find((h) => h.id === c.agent?.hostId)?.capabilities ?? []) ?? []));
  const followedNode = (h: { capabilities: string[] }) => followed.has(clusterOf(h.capabilities) ?? '');
  const toast = useToast();
  const [id, setId] = useState('');
  const toForm = (c: PveCluster | null): PveClusterInput =>
    c ? { name: c.name, url: c.url, fingerprint: c.fingerprint, ...(c.agent ? { agent: c.agent } : {}) } : { name: '', url: '', fingerprint: '' };
  const [initial, setInitial] = useState<PveClusterInput>(() => toForm(cluster));
  const [form, setForm] = useState<PveClusterInput>(initial);
  // the token is saved as soon as the agent created it, with the cluster (created if new)
  const [saved, setSaved] = useState<PveCluster | null>(cluster);
  const [tokenId, setTokenId] = useState(cluster?.tokenId || DEFAULT_TOKEN);
  const [detected, setDetected] = useState<PveDetected | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const set = (patch: Partial<PveClusterInput>) => setForm({ ...form, ...patch });
  const clusterId = saved?.id ?? id;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || (!saved && !!id);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['settings', 'pve'] });
    qc.invalidateQueries({ queryKey: ['backups'] });
  };

  const save = async () => {
    setBusy('save');
    try {
      await api.savePveCluster(clusterId, form);
      refresh();
      toast.success('Enregistré : relevé du cluster en cours');
      onClose();
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  useSettingsDraft(dirty, save, onClose);
  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      const r = await api.testPveCluster(clusterId, form);
      setTest(
        r.ok
          ? { level: 'ok', title: 'Connexion réussie', detail: `${r.cluster ? `cluster ${r.cluster}, ` : ''}nœuds : ${r.nodes?.join(', ')} · ${r.jobs} job(s) de sauvegarde` }
          : { level: 'error', title: 'Échec', detail: r.error ?? 'échec' },
      );
    } catch (err) {
      setTest({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // addresses of the node, by interface: the hub reaches the API at the one chosen
  const choices = (detected?.interfaces ?? []).flatMap((i) => i.ips.map((ip) => ({ iface: i.name, ip, def: !!i.default })));
  const chosenIp = hostOf(form.url);
  const [node, found, token, tested] = stepStates([!!form.agent, !!form.url, !!saved?.hasSecret, test?.level === 'ok']);

  const options = (
    <>
      <label className="flex min-w-0 flex-col items-stretch gap-1 text-xs text-muted lg:flex-row lg:items-center lg:gap-2" title="Fixé à la création du jeton">
            <span className="shrink-0">Identifiant</span>
            <input className="input h-10 w-full lg:h-8 lg:w-36 py-1 font-mono text-xs" value={clusterId} disabled={!!saved} onChange={(e) => setId(slug(e.target.value))} placeholder="vouille" spellCheck={false} />
          </label>
          <label className="flex min-w-0 flex-col items-stretch gap-1 text-xs text-muted lg:flex-row lg:items-center lg:gap-2">
            <span className="shrink-0">Nom affiché</span>
            <input className="input h-10 w-full lg:h-8 lg:w-44 py-1" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Vouillé" />
          </label>
    </>
  );

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        fixed
        title={cluster ? `Cluster ${cluster.name}` : 'Nouveau cluster Proxmox VE'}
        footer={
          <>
            <div className="mr-auto hidden min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-sm lg:flex">{options}</div>
            <Button disabled={busy !== null} onClick={onClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || !saved?.hasSecret} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps fill>
          <Step n={1} title="Nœud du cluster" state={node} intro="Un nœud dont l’agent est enrôlé : il décrit le cluster, ses interfaces et son certificat, puis crée le jeton.">
            <AgentPicker<PveDetected>
              capability="pve"
              exclude={followedNode}
              initialHostId={form.agent?.hostId}
              linked={form.agent && <p>Nœud relié : son agent a créé le jeton.</p>}
              primary={node === 'active'}
              detect={api.detectPve}
              onDetected={(hostId, r) => {
                setDetected(r);
                const ips = (r.interfaces ?? []).flatMap((i) => i.ips);
                const keep = ips.includes(hostOf(form.url));
                set({ agent: { hostId }, fingerprint: r.fingerprint ?? '', url: keep ? form.url : '', name: form.name || r.cluster || r.node || '' });
                if (!saved && !id) setId(slug(r.cluster || r.node || ''));
                setTest(null);
              }}
              detectTitle="L'agent décrit le nœud Proxmox VE : cluster, nœuds, interfaces, certificat"
              foundText={(r) => <p>Proxmox VE {r.version} · {r.cluster ? <>cluster <code>{r.cluster}</code></> : 'nœud seul'} · nœud {r.node}</p>}
              notFoundText="Pas de Proxmox VE sur cet hôte (pveum introuvable)."
              noAgentText="Aucun agent ne sait administrer Proxmox VE : installer ou mettre à jour l'agent d'un nœud du cluster."
            />
          </Step>
          <Step n={2} title="Détection" state={found} intro="Donné par l’agent, rien à saisir : choisir l’interface par laquelle le hub joint l’API du nœud.">
            <DetectedRows
              rows={[
                { label: 'Cluster', value: detected ? (detected.cluster ? `${detected.cluster} · ${detected.nodes?.join(', ')}` : `nœud seul (${detected.node})`) : undefined, empty: 'relancer Détecter' },
                { label: 'Empreinte du certificat', value: form.fingerprint, empty: 'aucune (autorités système)' },
              ]}
            />
            {detected ? (
              <label className="block">
                <span className={field}>Interface de l’API</span>
                <select className="input font-mono text-xs" value={choices.some((c) => c.ip === chosenIp) ? chosenIp : ''} onChange={(e) => (set({ url: e.target.value ? `https://${e.target.value}:${detected.port || PORT}` : '' }), setTest(null))}>
                  <option value="">— choisir l'interface —</option>
                  {choices.map((c) => (
                    <option key={c.ip} value={c.ip}>{c.iface} · {c.ip}{c.def ? ' (route par défaut)' : ''}</option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-muted">{form.url || 'Le hub doit pouvoir joindre cette adresse.'}</span>
              </label>
            ) : (
              <DetectedRows rows={[{ label: 'Adresse', value: form.url, empty: 'non choisie' }]} />
            )}
          </Step>
          <Step
            n={3}
            title="Jeton du hub"
            state={token}
            intro={
              <>
                Utilisateur <code>homelab@pve</code>, rôle <b>PVEAuditor</b> sur <code>/</code> (lecture seule), donné à l’utilisateur et au jeton. Le secret va de l’agent au
                hub, jamais affiché.
              </>
            }
            footer={
              <p className="text-xs text-muted">
                {saved?.hasSecret ? <span className="text-emerald-400">Jeton enregistré : <code>{saved.tokenId}</code>.</span> : 'Aucun jeton enregistré.'} Un jeton existant
                garde son secret si le hub le connaît (sinon il est recréé) ; ses droits sont remis à ceux-ci.
              </p>
            }
          >
            <TokenButton
              tokenId={tokenId}
              onTokenIdChange={setTokenId}
              disabled={!form.agent || !form.url || !clusterId}
              primary={token === 'active'}
              create={async () => {
                const r = await api.createPveToken(clusterId, { hostId: form.agent!.hostId, tokenId, name: form.name, url: form.url, fingerprint: form.fingerprint });
                setSaved(r.cluster);
                setInitial(toForm(r.cluster));
                setForm(toForm(r.cluster));
                refresh();
                return r;
              }}
            />
            {!clusterId && <p className="text-xs text-amber-400">Renseigner l’identifiant du cluster (pied de la fenêtre).</p>}
          </Step>
          <Step
            n={4}
            title="Test de connexion"
            state={tested}
            intro="Le hub lit le cluster avec le jeton enregistré, à l’adresse choisie."
            footer={
              <Button
                className="w-full"
                variant={tested === 'active' ? 'primary' : 'secondary'}
                icon={Plug}
                loading={busy === 'test'}
                disabled={busy !== null || !form.url || !saved?.hasSecret}
                onClick={() => void runTest()}
              >
                {test ? 'Tester à nouveau' : 'Tester la connexion'}
              </Button>
            }
          >
            <CheckLine label="API" check={test} idle={form.url || undefined} />
          </Step>
        </Steps>
        {/* narrow windows: the options leave the footer (buttons only) and follow the steps */}
        <div className="mt-3 flex flex-col gap-3 lg:hidden">{options}</div>
      </Modal>
      <ConfirmModal
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={onClose}
        title="Abandonner les modifications ?"
        confirmLabel="Abandonner"
        danger
      >
        Les paramètres du cluster modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

// Paramètres › Sauvegardes: the Proxmox VE clusters are roles of the hub (Cluster Proxmox VE), declared in Paramètres › Rôles,
// their inventory in Paramètres › Proxmox VE.
