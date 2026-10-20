import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, Pencil, Plug, Save, Unplug } from 'lucide-react';
import { api, type PbsSettings, type PbsTestResult, type PbsSettingsInput } from '../lib/api';
import { useToast } from '../lib/toast';
import { ServerRow } from './ProxmoxServer';
import { CheckLine, DetectedRows, Step, Steps, type CheckState } from './PbsDialog';
import { stepStates } from '../lib/steps';
import { PbsAgentPicker, TokenButton } from './AgentPicker';
import { useSettingsDraft } from './settingsDraft';
import { PbsDisconnectModal } from './PbsDisconnect';
import { Button, ConfirmModal, Modal, Panel, Spinner } from './ui';

const DEFAULT_TOKEN = 'homelab@pbs!monitor';

// the PBS filters the list by permission instead of answering 403
function outcome(r: PbsTestResult): CheckState {
  if (!r.ok) return { level: 'error', title: 'Échec', detail: r.error ?? 'échec' };
  if (!r.datastores?.length) return { level: 'warn', title: 'Aucun datastore visible', detail: 'Vérifier DatastoreAudit sur /datastore pour l’utilisateur ET le jeton.' };
  return { level: 'ok', title: 'Connexion réussie', detail: `Datastores visibles : ${r.datastores.join(', ')}` };
}

function PbsModal({ data, open, onClose }: { data: PbsSettings; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [initial] = useState<PbsSettingsInput>(() => ({
    url: data.url,
    fingerprint: data.fingerprint,
    ...(data.agent ? { agent: data.agent } : {}),
    clientImage: data.clientImage ?? '',
    mountRoot: data.mountRoot ?? '/srv/pbs-restore',
    tailscaleUrl: data.tailscaleUrl ?? '',
  }));
  const [form, setForm] = useState<PbsSettingsInput>(initial);
  // the token is saved as soon as the agent created it, apart from the form
  const [tokenId, setTokenId] = useState(data.tokenId || DEFAULT_TOKEN);
  const [saved, setSaved] = useState(data);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const set = (patch: Partial<PbsSettingsInput>) => setForm((current) => ({ ...current, ...patch }));
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
      toast.success(saved.hasSecret ? 'Enregistré : relevé du PBS en cours' : 'Enregistré');
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
  // the LAN address only: the hub receives on the tailnet but cannot reach it (Tailscale in userspace)
  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      setTest(outcome(await api.testPbsSettings(form)));
    } catch (err) {
      setTest({ level: 'error', title: 'Échec', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const [host, detected, token, tested] = stepStates([!!form.agent, !!form.url, saved.hasSecret, test?.level === 'ok']);

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        wide="screen"
        title="Proxmox Backup Server"
        footer={
          <>
            <div className="mr-auto flex w-full min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-sm md:w-auto">
              <label className="flex min-w-0 items-center gap-2 text-xs text-muted" title="Répertoire racine des snapshots montés en lecture seule sur les hôtes de destination">
                <span className="shrink-0">Racine des montages</span>
                <input className="input h-8 w-56 py-1 font-mono text-xs" value={form.mountRoot} onChange={(e) => set({ mountRoot: e.target.value.trim() })} placeholder="/srv/pbs-restore" spellCheck={false} />
              </label>
              <label className="flex min-w-0 items-center gap-2 text-xs text-muted" title="Image Docker du client PBS, pour les hôtes sans client installé">
                <span className="shrink-0">Image du client</span>
                <input className="input h-8 w-60 py-1 font-mono text-xs" value={form.clientImage ?? ''} onChange={(e) => set({ clientImage: e.target.value.trim() })} placeholder="mathmath350/pbs-client:latest" spellCheck={false} />
              </label>
            </div>
            <Button disabled={busy !== null} onClick={onClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null} onClick={() => void save()}>Enregistrer</Button>
          </>
        }
      >
        <Steps>
          <Step n={1} title="Hôte du PBS" state={host} intro="Son agent trouve le PBS (installé, ou dans un conteneur lancé), donne ses adresses et son empreinte, puis crée les jetons.">
            <PbsAgentPicker
              link={form.agent}
              primary={host === 'active'}
              onDetected={(agent, found) => {
                set({ agent, url: found.url ?? '', tailscaleUrl: found.tailscaleUrl ?? '', ...(found.fingerprint ? { fingerprint: found.fingerprint } : {}) });
                setTest(null);
              }}
            />
          </Step>
          <Step n={2} title="Détection" state={detected} intro="Donné par l’agent, rien à saisir : relancer Détecter après un changement d’IP.">
            <DetectedRows
              rows={[
                { label: 'Adresse LAN', value: form.url, empty: 'non détectée' },
                { label: 'Adresse Tailscale', value: form.tailscaleUrl, empty: 'aucune : les hôtes du réseau Tailscale ne sauvegardent pas' },
                { label: 'Empreinte du certificat', value: form.fingerprint, empty: 'aucune (autorités système)' },
              ]}
            />
          </Step>
          <Step
            n={3}
            title="Jeton du hub"
            state={token}
            intro={
              <>
                Utilisateur <code>homelab@pbs</code>, rôle <b>DatastoreAudit</b> sur <code>/datastore</code> (lecture seule), donné à l’utilisateur et au jeton. Le secret va de
                l’agent au hub, jamais affiché.
              </>
            }
            footer={
              <p className="text-xs text-muted">
                {saved.hasSecret ? <span className="text-emerald-400">Jeton enregistré : <code>{saved.tokenId}</code>.</span> : 'Aucun jeton enregistré.'} Un jeton existant garde
                son secret si le hub le connaît (sinon il est recréé) ; ses droits sont remis à ceux-ci.
              </p>
            }
          >
            <TokenButton
              tokenId={tokenId}
              onTokenIdChange={setTokenId}
              disabled={!form.agent}
              primary={token === 'active'}
              create={async () => {
                const r = await api.createPbsToken(form.agent!, tokenId);
                qc.setQueryData(['settings', 'pbs'], r.settings);
                setSaved(r.settings);
                return r;
              }}
            />
          </Step>
          <Step
            n={4}
            title="Test de connexion"
            state={tested}
            intro="Depuis le hub, seule l’adresse LAN se teste : Tailscale n’y fonctionne qu’en entrée."
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
            <CheckLine label="LAN" check={test} idle={form.url || undefined} />
            {form.tailscaleUrl && (
              <CheckLine label="Tailscale" check={{ level: 'info', title: 'Non testable depuis le hub', detail: 'Les hôtes Tailscale joignent le PBS par leur propre Tailscale.' }} />
            )}
          </Step>
        </Steps>
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
  const [disconnecting, setDisconnecting] = useState(false);
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
            connected={data.connected}
            polledAt={data.polledAt}
            pollError={data.pollError}
            details={data.tokenId ? `jeton ${data.tokenId}` : 'aucun jeton'}
            onRemove={() => setDisconnecting(true)}
            removeTitle="Déconnecter"
            removeIcon={Unplug}
          />
        </ul>
      )}
      {data && editing && <PbsModal data={data} open onClose={() => setEditing(false)} />}
      {disconnecting && <PbsDisconnectModal open onClose={() => setDisconnecting(false)} />}
    </Panel>
  );
}
