import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plug, Save, ServerCog, Unplug } from 'lucide-react';
import { api, type PbsRemoteInput, type PbsRemoteSettings } from '../lib/api';
import { formatBytes, seriesRule } from '../lib/backups';
import { dateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { ServerRow, field } from './ProxmoxServer';
import { CheckLine, DetectedRows, Step, Steps, type CheckState } from './PbsDialog';
import { stepStates } from '../lib/steps';
import { PbsAgentPicker, TokenButton } from './AgentPicker';
import { useSettingsDraft } from './settingsDraft';
import { PbsDisconnectModal } from './PbsDisconnect';
import { Button, ConfirmModal, Modal, Panel, Spinner } from './ui';

const DEFAULT_HUB_TOKEN = 'homelab@pbs!hub';
const DEFAULT_READER_TOKEN = 'homelab@pbs!reader';

function RemoteModal({ data, open, onClose }: { data: PbsRemoteSettings; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: main } = useQuery({ queryKey: ['settings', 'pbs'], queryFn: api.pbsSettings });
  const [initial] = useState<PbsRemoteInput>(() => ({ url: data.url, fingerprint: data.fingerprint, ...(data.agent ? { agent: data.agent } : {}), startTime: data.startTime }));
  const [form, setForm] = useState<PbsRemoteInput>(initial);
  // tokens: saved as soon as the agents created them, apart from the form
  const [saved, setSaved] = useState(data);
  const [hubToken, setHubToken] = useState(data.tokenId || DEFAULT_HUB_TOKEN);
  const [readerToken, setReaderToken] = useState(data.readerTokenId || DEFAULT_READER_TOKEN);
  const [stores, setStores] = useState<string[]>(data.store ? [data.store] : []);
  const [store, setStore] = useState(data.store);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  const [namespaces, setNamespaces] = useState<CheckState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const set = (patch: Partial<PbsRemoteInput>) => setForm({ ...form, ...patch });
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const keep = (s: PbsRemoteSettings) => {
    qc.setQueryData(['settings', 'pbs-remote'], s);
    setSaved(s);
  };

  const save = async () => {
    setBusy('save');
    try {
      const next = await api.savePbsRemoteSettings(form);
      qc.setQueryData(['settings', 'pbs-remote'], next);
      qc.invalidateQueries({ queryKey: ['backups'] });
      toast.success(next.connected ? 'Enregistré : relevé du PBS de secours en cours' : 'Enregistré');
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
    setNamespaces(null);
    try {
      const r = await api.testPbsRemoteSettings(form);
      if (!r.ok) setTest({ level: 'error', title: 'Échec', detail: r.error ?? 'échec' });
      else if (!r.datastores?.includes(saved.store)) setTest({ level: 'warn', title: `Datastore ${saved.store} non visible`, detail: 'Recréer le jeton du hub.' });
      else {
        setTest({ level: 'ok', title: 'Connexion réussie', detail: `Datastore ${saved.store} visible` });
        const ns = r.namespaces?.filter(Boolean) ?? [];
        setNamespaces(ns.length ? { level: 'ok', title: ns.join(', ') } : { level: 'warn', title: 'Aucun namespace', detail: 'À créer à la main dans le datastore cible.' });
      }
    } catch (err) {
      setTest({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const [host, detected, tokens, tested] = stepStates([!!form.agent, !!form.url && !!store, saved.hasSecret && saved.hasReaderSecret, test?.level === 'ok']);

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        wide="screen" low
        title="PBS de secours"
        footer={
          <>
            <div className="mr-auto flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <label
                className="flex items-center gap-2 text-xs text-muted"
                title="Chaque jour à cette heure, l’agent du PBS de secours lance les jobs de copie l’un après l’autre (un par datastore et namespace copié) ; les copies continuent quand le hub est arrêté. Seuls les snapshots vérifiés sont copiés : laisser aux sauvegardes du PBS principal le temps de finir et d’être vérifiées."
              >
                <span className="shrink-0">Départ des copies</span>
                <input type="time" className="input h-8 w-28 py-1 font-mono text-xs" value={form.startTime ?? data.startTime} onChange={(e) => set({ startTime: e.target.value })} />
              </label>
            </div>
            <Button disabled={busy !== null} onClick={onClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps>
          <Step n={1} title="Hôte du PBS de secours" state={host} intro="Son agent trouve le PBS (installé, ou dans un conteneur lancé), crée le jeton du hub et lance les copies quotidiennes.">
            <PbsAgentPicker
              link={form.agent}
              excludeHostId={main?.agent?.hostId}
              primary={host === 'active'}
              onDetected={(agent, found) => {
                set({ agent, url: found.url ?? '', ...(found.fingerprint ? { fingerprint: found.fingerprint } : {}) });
                setStores(found.datastores ?? []);
                if (!store && found.datastores?.length === 1) setStore(found.datastores[0]);
                setTest(null);
                setNamespaces(null);
              }}
            />
          </Step>
          <Step n={2} title="Détection" state={detected} intro="Donné par l’agent, rien à saisir : relancer Détecter après un changement d’IP.">
            <DetectedRows
              rows={[
                { label: 'Adresse', value: form.url, empty: 'non détectée' },
                { label: 'Empreinte du certificat', value: form.fingerprint, empty: 'aucune (autorités système)' },
              ]}
            />
            <label className="block">
              <span className={field}>Datastore cible</span>
              <select className="input" value={store} onChange={(e) => setStore(e.target.value)} disabled={!form.agent}>
                <option value="">— détecter d’abord —</option>
                {stores.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="mt-1 block text-xs text-muted">Enregistré avec le jeton du hub, qui n’a de droits que sur lui.</span>
            </label>
          </Step>
          <Step n={3} title="Jetons" state={tokens} intro="Créés par les agents des deux PBS, jamais affichés. Le PBS de secours tire les sauvegardes du PBS principal avec le jeton lecteur.">
            <div className="space-y-2">
              <p className="text-xs font-medium text-zinc-200">Hub, sur le PBS de secours</p>
              <TokenButton
                tokenId={hubToken}
                onTokenIdChange={setHubToken}
                disabled={!form.agent || !store}
                primary={tokens === 'active' && !saved.hasSecret}
                create={async () => {
                  const r = await api.createPbsRemoteToken(form.agent!, hubToken, store);
                  keep(r.settings);
                  return r;
                }}
              />
              <p className="text-xs text-muted">
                {saved.hasSecret ? <span className="text-emerald-400">Enregistré : <code>{saved.tokenId}</code> sur <code>{saved.store}</code>.</span> : form.agent && !store ? 'Choisir d’abord le datastore cible.' : 'Aucun jeton enregistré.'}{' '}
                <b>DatastoreBackup</b> et <b>DatastoreAudit</b> sur le datastore, <b>RemoteAdmin</b> sur <code>/remote</code>.
              </p>
            </div>
            <div className="space-y-2 border-t border-line pt-3">
              <p className="text-xs font-medium text-zinc-200">Lecteur, sur le PBS principal</p>
              {main?.agent ? (
                <TokenButton
                  tokenId={readerToken}
                  onTokenIdChange={setReaderToken}
                  primary={tokens === 'active' && saved.hasSecret && !saved.hasReaderSecret}
                  create={async () => {
                    const r = await api.createPbsReaderToken(readerToken);
                    keep(r.settings);
                    return r;
                  }}
                />
              ) : (
                <p className="text-xs text-amber-400">Le PBS principal n’est pas relié à son agent : le faire dans la fenêtre Proxmox Backup Server (étape 1).</p>
              )}
              <p className="text-xs text-muted">
                {saved.hasReaderSecret ? <span className="text-emerald-400">Enregistré : <code>{saved.readerTokenId}</code>.</span> : 'Aucun jeton enregistré.'}{' '}
                <b>DatastoreReader</b> sur <code>/datastore</code> (lecture seule).
              </p>
            </div>
          </Step>
          <Step
            n={4}
            title="Test de connexion"
            state={tested}
            intro={
              <>
                Les namespaces cibles (mêmes noms que sur le PBS principal) sont <b>à créer à la main</b> dans le datastore cible : le jeton du hub n’a pas le droit de les créer.
              </>
            }
            footer={
              <Button
                className="w-full"
                variant={tested === 'active' ? 'primary' : 'secondary'}
                icon={Plug}
                loading={busy === 'test'}
                disabled={busy !== null || !form.url || !saved.hasSecret}
                onClick={() => void runTest()}
              >
                {test ? 'Tester à nouveau' : 'Tester la connexion'}
              </Button>
            }
          >
            <CheckLine label="Connexion" check={test} idle={form.url || undefined} />
            <CheckLine label="Namespaces" check={namespaces} idle={saved.store ? `dans ${saved.store}` : undefined} />
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        Les paramètres du PBS de secours modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

// State of the daily series under the server: who runs it, its rule, its last report.
function SeriesStatus({ data }: { data: PbsRemoteSettings }) {
  const s = data.series;
  return (
    <div className="mt-3 space-y-1 text-xs">
      <p className="text-muted">
        Copies : {seriesRule(s)} · {s.jobs} job{s.jobs > 1 ? 's' : ''} de copie.
      </p>
      {!s.active ? (
        <p className="text-amber-400">L’agent du PBS de secours ne sait pas lancer les copies (à mettre à jour) : aucune copie n’est lancée.</p>
      ) : !s.agentOnline ? (
        <p className="text-amber-400">Agent du PBS de secours hors ligne : aucune copie n’est lancée.</p>
      ) : (
        <p className="text-muted">
          {s.running ? `copie en cours : ${s.running}` : 'aucune copie en cours'}
          {s.pending ? ` · ${s.pending} sur ${s.total} à suivre` : ''}
          {s.nextStart ? ` · prochaine série ${dateTime(s.nextStart)}` : ''}
        </p>
      )}
      {s.error && <p className="text-red-400">{s.error}</p>}
    </div>
  );
}

// Secondary PBS: copy of chosen backups (Paramètres > Sauvegardes).
export function OffsiteSettings() {
  const { data } = useQuery({ queryKey: ['settings', 'pbs-remote'], queryFn: api.pbsRemoteSettings });
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const usage = data?.usage;
  return (
    <Panel title="PBS de secours (copie déportée)" icon={ServerCog} actions={data && <Button size="sm" icon={Pencil} onClick={() => setEditing(true)}>{data.url ? 'Modifier' : 'Configurer'}</Button>}>
      <p className="mb-4 text-sm text-muted">
        Un second Proxmox Backup Server, distant, qui tire du PBS principal les sauvegardes choisies une à une. Son agent lance les copies chaque jour ; le hub
        relève leur état toutes les 15 minutes.
      </p>
      {!data ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : !data.url ? (
        <p className="text-sm text-muted">Aucun PBS de secours configuré.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          <ServerRow
            name="PBS de secours"
            tag={data.store || undefined}
            url={data.url}
            connected={data.connected}
            polledAt={data.polledAt}
            pollError={data.pollError}
            details={usage ? `${formatBytes(usage.avail)} libres sur ${formatBytes(usage.total)}` : data.tokenId ? `jeton ${data.tokenId}` : 'aucun jeton'}
            onRemove={() => setDisconnecting(true)}
            removeTitle="Déconnecter"
            removeIcon={Unplug}
          />
        </ul>
      )}
      {data?.connected && <SeriesStatus data={data} />}
      {data && editing && <RemoteModal data={data} open onClose={() => setEditing(false)} />}
      {data && disconnecting && <PbsDisconnectModal open remote={data} onClose={() => setDisconnecting(false)} />}
    </Panel>
  );
}
