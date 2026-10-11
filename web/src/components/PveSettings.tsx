import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Pencil, Plug, Plus, Save, Server, Trash2 } from 'lucide-react';
import { api, type PveCluster, type PveClusterInput } from '../lib/api';
import { timeAgo } from '../lib/format';
import { pveTokenScript } from '../lib/tokenScripts';
import { useToast } from '../lib/toast';
import { TokenSetup } from './TokenSetup';
import { Badge, Button, ConfirmModal, CopyField, Modal, Panel, Spinner } from './ui';

const pveSetup = (token: string) => pveTokenScript({ user: 'homelab@pve', token, path: '/', role: 'PVEAuditor' });

const EMPTY: PveClusterInput = { name: '', url: '', fingerprint: '', tokenId: '', enabled: true };

// One cluster: create (id typed) or edit (id fixed); the secret is never sent back by the hub.
function ClusterModal({ cluster, open, onClose }: { cluster: PveCluster | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [id, setId] = useState('');
  const [draft, setDraft] = useState<PveClusterInput | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'fp' | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [token, setToken] = useState(cluster?.tokenId.split('!')[1] || 'monitor');
  const form: PveClusterInput = draft ?? (cluster ? { name: cluster.name, url: cluster.url, fingerprint: cluster.fingerprint, tokenId: cluster.tokenId, enabled: cluster.enabled } : EMPTY);
  const set = (patch: Partial<PveClusterInput>) => setDraft({ ...form, ...patch });
  const clusterId = cluster?.id ?? id;
  const body = (): PveClusterInput => {
    const { tokenSecret, ...rest } = form;
    return tokenSecret ? { ...rest, tokenSecret } : rest;
  };
  const close = () => {
    setDraft(null);
    setId('');
    setTest(null);
    onClose();
  };

  const save = async () => {
    setBusy('save');
    try {
      await api.savePveCluster(clusterId, body());
      qc.invalidateQueries({ queryKey: ['settings', 'pve'] });
      qc.invalidateQueries({ queryKey: ['backups'] });
      toast.success(form.enabled ? 'Enregistré : relevé du cluster en cours' : 'Enregistré');
      close();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      const r = await api.testPveCluster(clusterId, body());
      setTest(r.ok ? { ok: true, text: `Connexion réussie · ${r.cluster ? `cluster ${r.cluster}, ` : ''}nœuds : ${r.nodes?.join(', ')} · ${r.jobs} job(s) de sauvegarde` } : { ok: false, text: r.error ?? 'échec' });
    } catch (err) {
      setTest({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const fetchFp = async () => {
    setBusy('fp');
    try {
      set({ fingerprint: (await api.pveFingerprint(form.url)).fingerprint });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const field = 'mb-1.5 block text-xs font-medium text-muted';
  return (
    <Modal
      open={open}
      onClose={close}
      wide="xl"
      title={cluster ? `Cluster ${cluster.name}` : 'Nouveau cluster Proxmox VE'}
      footer={
        <>
          <Button icon={Plug} loading={busy === 'test'} disabled={!clusterId || !form.url || !form.tokenId} onClick={runTest}>Tester la connexion</Button>
          <Button onClick={close}>Annuler</Button>
          <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={!clusterId} onClick={save}>Enregistrer</Button>
        </>
      }
    >
      <div className="grid gap-6 text-sm lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className={field}>Identifiant</span>
              <input className="input font-mono text-xs" value={clusterId} disabled={!!cluster} onChange={(e) => setId(e.target.value.trim().toLowerCase())} placeholder="vouille" spellCheck={false} />
            </label>
            <label className="block">
              <span className={field}>Nom affiché</span>
              <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Vouillé" />
            </label>
          </div>
          <label className="block">
            <span className={field}>Adresse d'un nœud</span>
            <input className="input" value={form.url} onChange={(e) => set({ url: e.target.value.trim() })} placeholder="https://192.168.100.241:8006" spellCheck={false} />
          </label>
          <div>
            <span className={field}>Empreinte du certificat (SHA-256)</span>
            <div className="flex gap-2">
              <input className="input font-mono text-xs" value={form.fingerprint} onChange={(e) => set({ fingerprint: e.target.value.trim() })} placeholder="AB:CD:… (vide : autorités système)" spellCheck={false} />
              <Button icon={Fingerprint} loading={busy === 'fp'} disabled={!form.url} onClick={fetchFp} title="Lit l'empreinte du certificat présenté par le nœud">Récupérer</Button>
            </div>
            <p className="mt-1 text-xs text-muted">À comparer avec celle du nœud (Système › Certificats, pve-ssl.pem) avant d'enregistrer.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className={field}>Identifiant du jeton</span>
              <input className="input font-mono text-xs" value={form.tokenId} onChange={(e) => set({ tokenId: e.target.value.trim() })} placeholder="homelab@pve!monitor" spellCheck={false} />
            </label>
            <label className="block">
              <span className={field}>Secret du jeton</span>
              <input
                className="input font-mono text-xs"
                type="password"
                autoComplete="off"
                value={form.tokenSecret ?? ''}
                onChange={(e) => set({ tokenSecret: e.target.value.trim() })}
                placeholder={cluster?.hasSecret ? '•••••••• (inchangé)' : 'xxxxxxxx-xxxx-…'}
              />
            </label>
          </div>
          <label className="flex cursor-pointer items-center gap-3">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-emerald-500" />
            <span>Relever ce cluster</span>
          </label>
          {test && <p className={test.ok ? 'text-xs text-emerald-400' : 'text-xs text-red-400'}>{test.text}</p>}
        </div>
        <aside className="space-y-2 self-start rounded-md border border-line bg-raised/40 p-4 text-xs text-muted">
          <p className="font-medium text-zinc-100">Créer le jeton sur le cluster</p>
          <p>
            Jeton de l'utilisateur <code>homelab@pve</code>, rôle <b>PVEAuditor</b> sur <code>/</code> : lecture des guests, de leur configuration réseau, des jobs de
            sauvegarde et des tâches. Avec la séparation des privilèges, le rôle est donné à l'utilisateur <b>et</b> au jeton.
          </p>
          <TokenSetup
            where="d'un nœud du cluster"
            user="homelab@pve"
            token={token}
            onTokenChange={setToken}
            disabled={!clusterId || !form.url}
            request={() => ({ kind: 'pve', cluster: { id: clusterId, name: form.name, url: form.url, fingerprint: form.fingerprint } })}
            onDone={() => {
              qc.invalidateQueries({ queryKey: ['settings', 'pve'] });
              qc.invalidateQueries({ queryKey: ['backups'] });
              set({ tokenId: `homelab@pve!${token}`, tokenSecret: undefined });
            }}
          />
          {(!clusterId || !form.url) && <p>Renseigne d'abord l'identifiant et l'adresse du cluster : le jeton reçu l'enregistre et lance son relevé.</p>}
          <details>
            <summary className="cursor-pointer">Sans la commande : bloc à coller (affiche le secret à recopier)</summary>
            <div className="mt-2 space-y-2">
              <CopyField multiline value={pveSetup(token)} />
              <p>
                Ou dans l'interface, Centre de données › Permissions : <b>Utilisateurs</b> › Ajouter (realm <code>pve</code>), <b>Jetons d'API</b> › Ajouter, puis
                <b> Permissions</b> › « Permission utilisateur » et « Permission de jeton d'API », chemin <code>/</code>, rôle <code>PVEAuditor</code>.
              </p>
            </div>
          </details>
        </aside>
      </div>
    </Modal>
  );
}

// Proxmox VE clusters followed through their API (Paramètres > Sauvegardes).
export function PveSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'pve'], queryFn: api.pveSettings });
  const [editing, setEditing] = useState<PveCluster | 'new' | null>(null);
  const [removing, setRemoving] = useState<PveCluster | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.deletePveCluster(removing.id);
      qc.invalidateQueries({ queryKey: ['settings', 'pve'] });
      qc.invalidateQueries({ queryKey: ['backups'] });
      setRemoving(null);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Clusters Proxmox VE" icon={Server} actions={<Button size="sm" icon={Plus} onClick={() => setEditing('new')}>Ajouter</Button>}>
      <p className="mb-4 text-sm text-muted">
        Le hub lit les jobs de sauvegarde (vzdump) de chaque cluster, leur planification et le résultat de leurs tâches. Un hôte est lié à son CT ou sa VM par
        l'adresse MAC que remonte son agent : les sauvegardes de ce guest sur le PBS lui sont rattachées automatiquement, et son retard est jugé sur la
        planification du job.
      </p>
      {!data ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : data.clusters.length === 0 ? (
        <p className="text-sm text-muted">Aucun cluster.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {data.clusters.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-100">{c.name}</span>
                  <span className="font-mono text-xs text-muted">{c.id}</span>
                  {!c.enabled ? <Badge tone="neutral">désactivé</Badge> : c.pollError ? <Badge tone="bad">en erreur</Badge> : c.polledAt ? <Badge tone="ok">relevé</Badge> : null}
                </div>
                <div className="truncate text-xs text-muted">
                  {c.url}
                  {c.polledAt && <> · relevé {timeAgo(c.polledAt)}{c.guests !== undefined && ` · ${c.guests} guests`}{c.timezone && ` · ${c.timezone}`}</>}
                  {c.pollError && <span className="text-red-400"> · {c.pollError}</span>}
                </div>
              </div>
              <Button size="sm" variant="ghost" icon={Pencil} title="Modifier" onClick={() => setEditing(c)} />
              <Button size="sm" variant="ghost" icon={Trash2} title="Retirer" onClick={() => setRemoving(c)} />
            </li>
          ))}
        </ul>
      )}
      <ClusterModal key={editing === 'new' ? 'new' : editing?.id ?? 'none'} cluster={editing === 'new' ? null : editing} open={!!editing} onClose={() => setEditing(null)} />
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} title="Retirer le cluster" confirmLabel="Retirer" danger loading={busy}>
        Le hub ne relèvera plus <b>{removing?.name}</b> : les liens de ses guests avec les hôtes et le rattachement automatique de leurs sauvegardes sont retirés
        (les sauvegardes restent sur le PBS, orphelines).
      </ConfirmModal>
    </Panel>
  );
}
