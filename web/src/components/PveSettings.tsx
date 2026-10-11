import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Plus, Save, Server } from 'lucide-react';
import { api, type PveCluster, type PveClusterInput } from '../lib/api';
import { withoutEmptySecret } from '../lib/forms';
import { pveTokenScript, splitTokenId } from '../lib/tokenScripts';
import { useToast } from '../lib/toast';
import { ConnectionFields, ServerRow, TestResult, TokenAside, field, type TestState } from './ProxmoxServer';
import { TokenSetup } from './TokenSetup';
import { Button, ConfirmModal, Modal, Panel, Spinner } from './ui';

const DEFAULT_TOKEN = 'homelab@pve!monitor';
const pveSetup = (tokenId: string) => pveTokenScript({ ...splitTokenId(tokenId, 'homelab@pve', 'monitor'), path: '/', role: 'PVEAuditor' });

// One cluster: create (id typed) or edit (id fixed); the secret is never sent back by the hub.
function ClusterModal({ cluster, onClose }: { cluster: PveCluster | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [id, setId] = useState('');
  const [form, setForm] = useState<PveClusterInput>(
    cluster
      ? { name: cluster.name, url: cluster.url, fingerprint: cluster.fingerprint, tokenId: cluster.tokenId || DEFAULT_TOKEN, enabled: cluster.enabled }
      : { name: '', url: '', fingerprint: '', tokenId: DEFAULT_TOKEN, enabled: true },
  );
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<TestState>(null);
  const set = (patch: Partial<PveClusterInput>) => setForm({ ...form, ...patch });
  const clusterId = cluster?.id ?? id;

  const save = async () => {
    setBusy('save');
    try {
      await api.savePveCluster(clusterId, withoutEmptySecret(form));
      qc.invalidateQueries({ queryKey: ['settings', 'pve'] });
      qc.invalidateQueries({ queryKey: ['backups'] });
      toast.success(form.enabled ? 'Enregistré : relevé du cluster en cours' : 'Enregistré');
      onClose();
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
      const r = await api.testPveCluster(clusterId, withoutEmptySecret(form));
      setTest(
        r.ok
          ? { level: 'ok', text: `Connexion réussie · ${r.cluster ? `cluster ${r.cluster}, ` : ''}nœuds : ${r.nodes?.join(', ')} · ${r.jobs} job(s) de sauvegarde` }
          : { level: 'error', text: r.error ?? 'échec' },
      );
    } catch (err) {
      setTest({ level: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      wide="xl"
      title={cluster ? `Cluster ${cluster.name}` : 'Nouveau cluster Proxmox VE'}
      footer={
        <>
          <Button icon={Plug} loading={busy === 'test'} disabled={!clusterId || !form.url || !form.tokenId} onClick={runTest}>Tester la connexion</Button>
          <Button onClick={onClose}>Annuler</Button>
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
          <ConnectionFields
            form={form}
            set={set}
            hasSecret={!!cluster?.hasSecret}
            urlPlaceholder="https://192.168.100.241:8006"
            fingerprintHint="Adresse d'un nœud du cluster. À comparer avec l'empreinte du nœud (Système › Certificats, pve-ssl.pem)."
            fetchFingerprint={api.pveFingerprint}
            enabledLabel="Relever ce cluster"
          />
          <TestResult test={test} />
        </div>
        <TokenAside
          title="Créer le jeton sur le cluster"
          intro={
            <>
              Jeton de l'utilisateur <code>homelab@pve</code>, rôle <b>PVEAuditor</b> sur <code>/</code> : lecture des guests, de leur configuration réseau, des jobs de
              sauvegarde et des tâches. Avec la séparation des privilèges, le rôle est donné à l'utilisateur <b>et</b> au jeton.
            </>
          }
          setup={
            <>
              <TokenSetup
                where="d'un nœud du cluster"
                tokenId={form.tokenId}
                onTokenIdChange={(tokenId) => set({ tokenId })}
                disabled={!clusterId || !form.url}
                request={() => ({ kind: 'pve', cluster: { id: clusterId, name: form.name, url: form.url, fingerprint: form.fingerprint } })}
                onDone={() => {
                  qc.invalidateQueries({ queryKey: ['settings', 'pve'] });
                  qc.invalidateQueries({ queryKey: ['backups'] });
                  set({ tokenSecret: undefined });
                }}
              />
              {(!clusterId || !form.url) && <p>Renseigne d'abord l'identifiant et l'adresse du cluster : le jeton reçu l'enregistre et lance son relevé.</p>}
            </>
          }
          manualScript={pveSetup(form.tokenId)}
          manualUi={
            <>
              Ou dans l'interface, Centre de données › Permissions : <b>Utilisateurs</b> › Ajouter (realm <code>pve</code>), <b>Jetons d'API</b> › Ajouter, puis
              <b> Permissions</b> › « Permission utilisateur » et « Permission de jeton d'API », chemin <code>/</code>, rôle <code>PVEAuditor</code>.
            </>
          }
        />
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
        l'adresse MAC que remonte son agent : les sauvegardes de ce guest lui sont rattachées automatiquement, et leur retard est jugé sur la planification du job.
      </p>
      {!data ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : data.clusters.length === 0 ? (
        <p className="text-sm text-muted">Aucun cluster.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {data.clusters.map((c) => (
            <ServerRow
              key={c.id}
              name={c.name}
              tag={c.id}
              url={c.url}
              enabled={c.enabled}
              polledAt={c.polledAt}
              pollError={c.pollError}
              details={[c.guests !== undefined ? `${c.guests} guests` : '', c.timezone ?? '', c.tokenId ? `jeton ${c.tokenId}` : 'aucun jeton'].filter(Boolean).join(' · ')}
              onEdit={() => setEditing(c)}
              onRemove={() => setRemoving(c)}
            />
          ))}
        </ul>
      )}
      {editing && <ClusterModal key={editing === 'new' ? 'new' : editing.id} cluster={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} title="Retirer le cluster" confirmLabel="Retirer" danger loading={busy}>
        Le hub ne relèvera plus <b>{removing?.name}</b> : les liens de ses guests avec les hôtes et le rattachement automatique de leurs sauvegardes sont retirés
        (les sauvegardes restent sur le PBS, orphelines).
      </ConfirmModal>
    </Panel>
  );
}
