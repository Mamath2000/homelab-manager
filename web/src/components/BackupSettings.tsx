import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, Pencil, Plug, Save } from 'lucide-react';
import { api, type PbsSettings, type PbsTestResult, type PbsSettingsInput } from '../lib/api';
import { useToast } from '../lib/toast';
import { ServerRow, TestResult, field, type TestState } from './ProxmoxServer';
import { DetectedRows, NeedsHost, TabHead, TabMark } from './PbsDialog';
import { PbsAgentPicker, PbsTokenButton } from './PbsAgentPicker';
import { useSettingsDraft } from './settingsDraft';
import { useHosts } from '../lib/queries';
import { Button, ConfirmModal, Modal, Panel, Spinner, VerticalTabs } from './ui';

const DEFAULT_TOKEN = 'homelab@pbs!monitor';

type PbsTab = 'host' | 'connection' | 'token' | 'options';

// the PBS filters the list by permission instead of answering 403
function outcome(r: PbsTestResult, label: string): TestState {
  const prefix = label ? `${label} : ` : '';
  if (!r.ok) return { level: 'error', text: `${prefix}${r.error ?? 'échec'}` };
  if (!r.datastores?.length) return { level: 'warn', text: `${prefix}connexion réussie mais aucun datastore visible : vérifier DatastoreAudit sur /datastore pour l’utilisateur ET le jeton` };
  return { level: 'ok', text: `${prefix}connexion réussie · datastores : ${r.datastores.join(', ')}` };
}

function PbsModal({ data, open, onClose }: { data: PbsSettings; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [initial] = useState<PbsSettingsInput>(() => ({
    enabled: data.enabled,
    url: data.url,
    fingerprint: data.fingerprint,
    ...(data.agent ? { agent: data.agent } : {}),
    clientImage: data.clientImage ?? '',
    tailscaleUrl: data.tailscaleUrl ?? '',
  }));
  const [form, setForm] = useState<PbsSettingsInput>(initial);
  // the token is saved as soon as the agent created it, apart from the form
  const [tokenId, setTokenId] = useState(data.tokenId || DEFAULT_TOKEN);
  const [saved, setSaved] = useState(data);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<TestState>(null);
  const [testTs, setTestTs] = useState<TestState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [tab, setTab] = useState<PbsTab>(data.agent ? 'connection' : 'host');
  const { data: hosts } = useHosts();
  const set = (patch: Partial<PbsSettingsInput>) => setForm({ ...form, ...patch });
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const save = async () => {
    setBusy('save');
    try {
      qc.setQueryData(['settings', 'pbs'], await api.savePbsSettings(form));
      qc.invalidateQueries({ queryKey: ['backups'] });
      toast.success(form.enabled ? 'Enregistré : relevé du PBS en cours' : 'Enregistré');
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
    setTestTs(null);
    try {
      const r = await api.testPbsSettings(form);
      // the hub only receives on the tailnet: the Tailscale address is not tried
      setTest(outcome(r, form.tailscaleUrl ? 'LAN' : ''));
      if (form.tailscaleUrl) setTestTs({ level: 'info', text: 'Tailscale : non testable depuis le hub (Tailscale en entrée seulement) ; les agents des hôtes Tailscale joignent le PBS par leur propre Tailscale.' });
    } catch (err) {
      setTest({ level: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const go = (t: PbsTab) => setTab(t);
  const tabs: { id: PbsTab; label: string; count?: ReactNode }[] = [
    { id: 'host', label: 'Hôte', count: <TabMark done={!!form.agent} /> },
    { id: 'connection', label: 'Connexion', count: form.agent ? <TabMark done={!!form.url} /> : undefined },
    { id: 'token', label: 'Jeton', count: <TabMark done={saved.hasSecret} /> },
    { id: 'options', label: 'Options' },
  ];
  const hostName = hosts?.find((h) => h.id === form.agent?.hostId)?.name;
  const summary = [hostName ?? 'aucun hôte relié', form.url || 'adresse non détectée', saved.hasSecret ? `jeton ${saved.tokenId}` : 'aucun jeton', form.enabled ? '' : 'suivi désactivé']
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        wide="screen"
        title="Proxmox Backup Server"
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
              <TabHead title="Hôte du PBS">
                L’agent de l’hôte trouve le PBS (installé, ou dans un conteneur lancé) et donne son adresse sur le LAN et sur Tailscale, son port et l’empreinte de son
                certificat : rien n’est à saisir. Il crée ensuite les jetons.
              </TabHead>
              <PbsAgentPicker
                link={form.agent}
                onDetected={(agent, found) =>
                  set({ agent, url: found.url ?? '', tailscaleUrl: found.tailscaleUrl ?? '', ...(found.fingerprint ? { fingerprint: found.fingerprint } : {}) })
                }
              />
            </section>
          )}
          {tab === 'connection' && (
            <section className="space-y-4 text-sm">
              <TabHead title="Connexion">Adresses données aux agents des hôtes selon leur réseau d’accès, avec la même empreinte. Relancer Détecter après un changement d’IP.</TabHead>
              {!form.agent && <NeedsHost onGo={() => go('host')} />}
              <DetectedRows
                rows={[
                  { label: 'LAN', value: form.url, empty: 'non détectée' },
                  { label: 'Tailscale', value: form.tailscaleUrl, empty: 'aucune IP Tailscale : les hôtes du réseau Tailscale ne sauvegardent pas' },
                  { label: 'Empreinte', value: form.fingerprint, empty: 'aucune (autorités système)' },
                ]}
              />
              <div className="space-y-1">
                <TestResult test={test} />
                <TestResult test={testTs} />
              </div>
            </section>
          )}
          {tab === 'token' && (
            <section className="space-y-4 text-sm">
              <TabHead title="Jeton de supervision">
                L’agent de l’hôte du PBS crée l’utilisateur <code>homelab@pbs</code> et son jeton, rôle <b>DatastoreAudit</b> sur <code>/datastore</code> (lecture seule),
                donné à l’utilisateur <b>et</b> au jeton : les droits d’un jeton PBS sont l’intersection des siens et de ceux de son utilisateur. Le secret va de l’agent au
                hub, jamais affiché. Le même agent crée ensuite les jetons des hôtes.
              </TabHead>
              {!form.agent && <NeedsHost onGo={() => go('host')} />}
              <PbsTokenButton
                tokenId={tokenId}
                onTokenIdChange={setTokenId}
                disabled={!form.agent}
                create={async () => {
                  const r = await api.createPbsToken(form.agent!, tokenId);
                  qc.setQueryData(['settings', 'pbs'], r.settings);
                  setSaved(r.settings);
                  return r;
                }}
              />
              <p className="text-xs text-muted">
                {saved.hasSecret ? <>Jeton enregistré : <code>{saved.tokenId}</code>.</> : 'Aucun jeton enregistré.'} Un jeton existant garde son secret ; ses droits sont
                remis à ceux ci-dessus (les autres lui sont retirés).
              </p>
            </section>
          )}
          {tab === 'options' && (
            <section className="space-y-4 text-sm">
              <TabHead title="Options" />
              <label className="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-emerald-500" />
                <span>Suivre les sauvegardes du PBS</span>
              </label>
              <label className="block">
                <span className={field}>Image du client (hôtes sans client installé)</span>
                <input className="input font-mono text-xs" value={form.clientImage ?? ''} onChange={(e) => set({ clientImage: e.target.value.trim() })} placeholder="mathmath350/pbs-client:latest" spellCheck={false} />
              </label>
            </section>
          )}
        </VerticalTabs>
      </Modal>
      <ConfirmModal
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={onClose}
        title="Abandonner les modifications ?"
        confirmLabel="Abandonner"
        danger
      >
        Les paramètres PBS modifiés ne seront pas enregistrés.
      </ConfirmModal>
    </>
  );
}

// Proxmox Backup Server followed through its API (Paramètres > Sauvegardes).
export function BackupSettings() {
  const { data } = useQuery({ queryKey: ['settings', 'pbs'], queryFn: api.pbsSettings });
  const [editing, setEditing] = useState(false);
  return (
    <Panel title="Proxmox Backup Server" icon={DatabaseBackup} actions={data && <Button size="sm" icon={Pencil} onClick={() => setEditing(true)}>{data.url ? 'Modifier' : 'Configurer'}</Button>}>
      <p className="mb-4 text-sm text-muted">
        Le hub lit l'API du PBS avec un jeton en lecture seule : il relève les groupes de sauvegarde toutes les 15 minutes, les rattache aux hôtes et suit leur
        retard.
      </p>
      {!data ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : !data.url ? (
        <p className="text-sm text-muted">Aucun PBS configuré.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          <ServerRow
            name="Proxmox Backup Server"
            url={data.url}
            enabled={data.enabled}
            polledAt={data.polledAt}
            pollError={data.pollError}
            details={data.tokenId ? `jeton ${data.tokenId}` : 'aucun jeton'}
          />
        </ul>
      )}
      {data && editing && <PbsModal data={data} open onClose={() => setEditing(false)} />}
    </Panel>
  );
}
