import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plug, Save, ServerCog } from 'lucide-react';
import { api, type PbsRemoteInput, type PbsRemoteSettings } from '../lib/api';
import { formatBytes, seriesRule } from '../lib/backups';
import { dateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { ConnectionFields, ServerRow, TestResult, TokenAside, field, type TestState } from './ProxmoxServer';
import { PbsAgentPicker, PbsTokenButton } from './PbsAgentPicker';
import { useSettingsDraft } from './settingsDraft';
import { Button, ConfirmModal, Modal, Panel, Spinner } from './ui';

const DEFAULT_HUB_TOKEN = 'homelab@pbs!hub';
const DEFAULT_READER_TOKEN = 'homelab@pbs!reader';

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

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        wide="xl"
        title="PBS de secours"
        footer={
          <>
            <Button icon={Plug} loading={busy === 'test'} disabled={busy !== null || !form.url || !saved.hasSecret} onClick={runTest}>Tester la connexion</Button>
            <Button disabled={busy !== null} onClick={onClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <div className="grid gap-6 text-sm lg:grid-cols-2">
          <div className="space-y-4">
            <ConnectionFields
              form={form}
              set={set}
              hasSecret={null}
              urlPlaceholder="https://192.168.2.101:8007"
              fingerprintHint="Lue par l'agent à la détection ; Récupérer lit celle que présente le serveur."
              fetchFingerprint={api.pbsFingerprint}
              enabledLabel="Copier les sauvegardes choisies vers ce PBS"
            />
            <TestResult test={test} />
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
          </div>
          <TokenAside
            title="Agents et jetons"
            intro={
              <>
                Deux jetons, créés par les agents des deux PBS et jamais affichés : celui du hub sur le PBS de secours (<b>DatastoreBackup</b> et <b>DatastoreAudit</b> sur
                le datastore cible, <b>RemoteAdmin</b> sur <code>/remote</code> : ni suppression de snapshot ni création de namespace), et un jeton lecteur sur le PBS
                principal (<b>DatastoreReader</b> sur <code>/datastore</code> : lecture seule), avec lequel le PBS de secours tire les sauvegardes.
              </>
            }
            setup={
              <div className="space-y-4">
                <PbsAgentPicker
                  link={form.agent}
                  onDetected={(agent, found) => {
                    set({ agent, ...(!form.url && found.url ? { url: found.url } : {}), ...(found.fingerprint ? { fingerprint: found.fingerprint } : {}) });
                    setStores(found.datastores ?? []);
                    if (!store && found.datastores?.length === 1) setStore(found.datastores[0]);
                  }}
                />
                <label className="block">
                  <span className={field}>Datastore cible</span>
                  <select className="input" value={store} onChange={(e) => setStore(e.target.value)}>
                    <option value="">— détecter d’abord —</option>
                    {stores.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <div className="space-y-1">
                  <p className="font-medium text-zinc-100">Jeton du hub sur le PBS de secours</p>
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
                  <p>{saved.hasSecret ? <>Enregistré : <code>{saved.tokenId}</code> sur <code>{saved.store}</code>.</> : 'Aucun jeton enregistré.'}</p>
                </div>
                <div className="space-y-1">
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
                    <p className="text-amber-400">Le PBS principal n'est pas relié à son agent : le faire dans le bloc Proxmox Backup Server.</p>
                  )}
                  <p>{saved.hasReaderSecret ? <>Enregistré : <code>{saved.readerTokenId}</code>.</> : 'Aucun jeton enregistré.'}</p>
                </div>
              </div>
            }
          />
        </div>
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
