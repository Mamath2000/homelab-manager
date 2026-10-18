import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plug, Save, ServerCog } from 'lucide-react';
import { api, type PbsRemoteInput, type PbsRemoteSettings } from '../lib/api';
import { formatBytes, seriesRule } from '../lib/backups';
import { dateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { ServerRow, TestResult, field, type TestState } from './ProxmoxServer';
import { DetectedRows, NeedsHost, TabHead, TabMark } from './PbsDialog';
import { PbsAgentPicker, PbsTokenButton } from './PbsAgentPicker';
import { useSettingsDraft } from './settingsDraft';
import { useHosts } from '../lib/queries';
import { Button, ConfirmModal, Modal, Panel, Spinner, VerticalTabs } from './ui';

const DEFAULT_HUB_TOKEN = 'homelab@pbs!hub';
const DEFAULT_READER_TOKEN = 'homelab@pbs!reader';

type RemoteTab = 'host' | 'connection' | 'tokens' | 'copies';

// Start of the daily series of the copies, run by the agent of the secondary (agent offsite.go).
function StartField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div>
        <p className="font-medium text-zinc-100">Copies quotidiennes</p>
        <p className="text-xs text-muted">
          Chaque jour à cette heure, l’agent du PBS de secours lance les jobs de copie l’un après l’autre (un par datastore et namespace copié), jamais deux à la fois ;
          les copies continuent quand le hub est arrêté.
        </p>
      </div>
      <label className="block sm:w-1/2">
        <span className={field}>Heure de départ</span>
        <input type="time" className="input font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
      <p className="text-xs text-muted">Seuls les snapshots vérifiés sont copiés : laisser aux sauvegardes du PBS principal le temps de finir et d’être vérifiées.</p>
    </div>
  );
}

function RemoteModal({ data, open, onClose }: { data: PbsRemoteSettings; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: main } = useQuery({ queryKey: ['settings', 'pbs'], queryFn: api.pbsSettings });
  const [initial] = useState<PbsRemoteInput>(() => ({ enabled: data.enabled, url: data.url, fingerprint: data.fingerprint, ...(data.agent ? { agent: data.agent } : {}), startTime: data.startTime }));
  const [form, setForm] = useState<PbsRemoteInput>(initial);
  // tokens: saved as soon as the agents created them, apart from the form
  const [saved, setSaved] = useState(data);
  const [hubToken, setHubToken] = useState(data.tokenId || DEFAULT_HUB_TOKEN);
  const [readerToken, setReaderToken] = useState(data.readerTokenId || DEFAULT_READER_TOKEN);
  const [stores, setStores] = useState<string[]>(data.store ? [data.store] : []);
  const [store, setStore] = useState(data.store);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<TestState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [tab, setTab] = useState<RemoteTab>(data.agent ? 'connection' : 'host');
  const { data: hosts } = useHosts();
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
      qc.setQueryData(['settings', 'pbs-remote'], await api.savePbsRemoteSettings(form));
      qc.invalidateQueries({ queryKey: ['backups'] });
      toast.success(form.enabled ? 'Enregistré : relevé du PBS de secours en cours' : 'Enregistré');
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
      const r = await api.testPbsRemoteSettings(form);
      if (!r.ok) setTest({ level: 'error', text: r.error ?? 'échec' });
      else if (!r.datastores?.includes(saved.store)) setTest({ level: 'warn', text: `connexion réussie mais le datastore ${saved.store} n’est pas visible : recréer le jeton du hub` });
      else setTest({ level: 'ok', text: `connexion réussie · ${saved.store} · namespaces : ${r.namespaces?.filter(Boolean).join(', ') || 'aucun (à créer dans PBS)'}` });
    } catch (err) {
      setTest({ level: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const go = (t: RemoteTab) => setTab(t);
  const tabs: { id: RemoteTab; label: string; count?: ReactNode }[] = [
    { id: 'host', label: 'Hôte', count: <TabMark done={!!form.agent} /> },
    { id: 'connection', label: 'Connexion', count: form.agent ? <TabMark done={!!form.url && !!store} /> : undefined },
    { id: 'tokens', label: 'Jetons', count: <TabMark done={saved.hasSecret && saved.hasReaderSecret} /> },
    { id: 'copies', label: 'Copies' },
  ];
  const hostName = hosts?.find((h) => h.id === form.agent?.hostId)?.name;
  const summary = [hostName ?? 'aucun hôte relié', form.url || 'adresse non détectée', saved.store || store || 'aucun datastore', form.enabled ? `copies à ${form.startTime ?? data.startTime}` : 'copies désactivées']
    .join(' · ');

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        wide="screen"
        title="PBS de secours"
        footer={
          <>
            <span className="mr-auto min-w-0 self-center truncate text-xs text-muted" title={summary}>{summary}</span>
            <Button icon={Plug} loading={busy === 'test'} disabled={busy !== null || !form.url || !saved.hasSecret} onClick={() => (setTab('connection'), void runTest())}>Tester la connexion</Button>
            <Button disabled={busy !== null} onClick={onClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <VerticalTabs tabs={tabs} value={tab} onChange={setTab} bodyClassName="pt-4 md:pt-1 md:pl-6">
          {tab === 'host' && (
            <section className="space-y-4 text-sm">
              <TabHead title="Hôte du PBS de secours">
                L’agent de l’hôte trouve le PBS (installé, ou dans un conteneur lancé) et donne son adresse, son port, l’empreinte de son certificat et ses datastores :
                rien n’est à saisir. Il crée ensuite le jeton du hub et lance les copies quotidiennes.
              </TabHead>
              <PbsAgentPicker
                link={form.agent}
                onDetected={(agent, found) => {
                  set({ agent, url: found.url ?? '', ...(found.fingerprint ? { fingerprint: found.fingerprint } : {}) });
                  setStores(found.datastores ?? []);
                  if (!store && found.datastores?.length === 1) setStore(found.datastores[0]);
                }}
              />
            </section>
          )}
          {tab === 'connection' && (
            <section className="space-y-4 text-sm">
              <TabHead title="Connexion">Adresse par laquelle le hub et le PBS principal joignent le PBS de secours. Relancer Détecter après un changement d’IP.</TabHead>
              {!form.agent && <NeedsHost onGo={() => go('host')} />}
              <DetectedRows
                rows={[
                  { label: 'Adresse', value: form.url, empty: 'non détectée' },
                  { label: 'Empreinte', value: form.fingerprint, empty: 'aucune (autorités système)' },
                ]}
              />
              <label className="block sm:w-1/2">
                <span className={field}>Datastore cible</span>
                <select className="input" value={store} onChange={(e) => setStore(e.target.value)} disabled={!form.agent}>
                  <option value="">— détecter d’abord —</option>
                  {stores.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <span className="mt-1 block text-xs text-muted">Enregistré avec le jeton du hub (onglet Jetons), qui n’a de droits que sur lui.</span>
              </label>
              <TestResult test={test} />
            </section>
          )}
          {tab === 'tokens' && (
            <section className="space-y-5 text-sm">
              <TabHead title="Jetons">
                Deux jetons, créés par les agents des deux PBS et jamais affichés : celui du hub sur le PBS de secours (<b>DatastoreBackup</b> et <b>DatastoreAudit</b> sur
                le datastore cible, <b>RemoteAdmin</b> sur <code>/remote</code> : ni suppression de snapshot ni création de namespace), et un jeton lecteur sur le PBS
                principal (<b>DatastoreReader</b> sur <code>/datastore</code> : lecture seule), avec lequel le PBS de secours tire les sauvegardes.
              </TabHead>
              <div className="space-y-2">
                <p className="font-medium text-zinc-100">Jeton du hub sur le PBS de secours</p>
                {!form.agent ? <NeedsHost onGo={() => go('host')} /> : !store && <p className="text-xs text-amber-400">Choisir d’abord le datastore cible (onglet Connexion).</p>}
                <PbsTokenButton
                  tokenId={hubToken}
                  onTokenIdChange={setHubToken}
                  disabled={!form.agent || !store}
                  create={async () => {
                    const r = await api.createPbsRemoteToken(form.agent!, hubToken, store);
                    keep(r.settings);
                    return r;
                  }}
                />
                <p className="text-xs text-muted">{saved.hasSecret ? <>Enregistré : <code>{saved.tokenId}</code> sur <code>{saved.store}</code>.</> : 'Aucun jeton enregistré.'}</p>
              </div>
              <div className="space-y-2 border-t border-line pt-4">
                <p className="font-medium text-zinc-100">Jeton lecteur sur le PBS principal</p>
                {main?.agent ? (
                  <PbsTokenButton
                    tokenId={readerToken}
                    onTokenIdChange={setReaderToken}
                    create={async () => {
                      const r = await api.createPbsReaderToken(readerToken);
                      keep(r.settings);
                      return r;
                    }}
                  />
                ) : (
                  <p className="text-xs text-amber-400">Le PBS principal n’est pas relié à son agent : le faire dans la fenêtre Proxmox Backup Server, onglet Hôte.</p>
                )}
                <p className="text-xs text-muted">{saved.hasReaderSecret ? <>Enregistré : <code>{saved.readerTokenId}</code>.</> : 'Aucun jeton enregistré.'}</p>
              </div>
            </section>
          )}
          {tab === 'copies' && (
            <section className="space-y-4 text-sm">
              <label className="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-emerald-500" />
                <span>Copier les sauvegardes choisies vers ce PBS</span>
              </label>
              <StartField value={form.startTime ?? data.startTime} onChange={(startTime) => set({ startTime })} />
              <div className="space-y-1 border-t border-line pt-4 text-xs text-muted">
                <p>
                  Le PBS de secours <b>tire</b> les sauvegardes du PBS principal (entrée remote <code>hlm-main</code>, déclarée par le hub) : un sync job par datastore et
                  namespace, dont le filtre liste les sauvegardes choisies une à une, sans planification : c’est l’agent du PBS de secours qui les lance. Les copies ne sont
                  jamais supprimées par le hub ; la rétention et les purges restent réglées dans le PBS de secours.
                </p>
                <p>
                  Les namespaces cibles (<code>Hosts</code>, <code>Vouille</code>…, mêmes noms que sur le PBS principal) sont <b>à créer à la main</b> dans le datastore cible :
                  le jeton du hub n'a pas le droit de les créer.
                </p>
              </div>
            </section>
          )}
        </VerticalTabs>
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
            enabled={data.enabled}
            polledAt={data.polledAt}
            pollError={data.pollError}
            details={usage ? `${formatBytes(usage.avail)} libres sur ${formatBytes(usage.total)}` : data.tokenId ? `jeton ${data.tokenId}` : 'aucun jeton'}
          />
        </ul>
      )}
      {data?.url && data.enabled && <SeriesStatus data={data} />}
      {data && editing && <RemoteModal data={data} open onClose={() => setEditing(false)} />}
    </Panel>
  );
}
