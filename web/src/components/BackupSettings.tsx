import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, Pencil, Plug, Save } from 'lucide-react';
import { api, type PbsSettings, type PbsTestResult, type PbsSettingsInput } from '../lib/api';
import { pbsTokenScript, splitTokenId } from '../lib/tokenScripts';
import { useToast } from '../lib/toast';
import { withoutEmptySecret } from '../lib/forms';
import { ConnectionFields, ServerRow, TestResult, TokenAside, field, type TestState } from './ProxmoxServer';
import { TokenSetup } from './TokenSetup';
import { Button, Modal, Panel, Spinner } from './ui';

const DEFAULT_TOKEN = 'homelab@pbs!monitor';
const pbsSetup = (tokenId: string) => pbsTokenScript({ ...splitTokenId(tokenId, 'homelab@pbs', 'monitor'), path: '/datastore', role: 'DatastoreAudit' });

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
  const [form, setForm] = useState<PbsSettingsInput>({
    enabled: data.enabled,
    url: data.url,
    fingerprint: data.fingerprint,
    tokenId: data.tokenId || DEFAULT_TOKEN,
    clientImage: data.clientImage ?? '',
    tailscaleUrl: data.tailscaleUrl ?? '',
  });
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<TestState>(null);
  const [testTs, setTestTs] = useState<TestState>(null);
  const set = (patch: Partial<PbsSettingsInput>) => setForm({ ...form, ...patch });

  const save = async () => {
    setBusy('save');
    try {
      qc.setQueryData(['settings', 'pbs'], await api.savePbsSettings(withoutEmptySecret(form)));
      qc.invalidateQueries({ queryKey: ['backups'] });
      toast.success(form.enabled ? 'Enregistré : relevé du PBS en cours' : 'Enregistré');
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
    setTestTs(null);
    try {
      const r = await api.testPbsSettings(withoutEmptySecret(form));
      // with a Tailscale address, each result says which address it is about
      const both = !!r.tailscale;
      setTest(outcome(r, both ? 'LAN' : ''));
      if (r.tailscale) setTestTs(outcome(r.tailscale, 'Tailscale'));
    } catch (err) {
      setTest({ level: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide="xl"
      title="Proxmox Backup Server"
      footer={
        <>
          <Button icon={Plug} loading={busy === 'test'} disabled={!form.url || !form.tokenId} onClick={runTest}>Tester la connexion</Button>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" icon={Save} loading={busy === 'save'} onClick={save}>Enregistrer</Button>
        </>
      }
    >
      <div className="grid gap-6 text-sm lg:grid-cols-2">
        <div className="space-y-4">
          <ConnectionFields
            form={form}
            set={set}
            hasSecret={data.hasSecret}
            urlPlaceholder="https://192.168.100.8:8007"
            fingerprintHint="Certificat auto-signé : son empreinte est épinglée. À comparer avec celle du PBS (Tableau de bord › Afficher l'empreinte)."
            fetchFingerprint={api.pbsFingerprint}
            enabledLabel="Suivre les sauvegardes du PBS"
          />
          <TestResult test={test} />
          <TestResult test={testTs} />
          <div className="space-y-4 border-t border-line pt-4">
            <label className="block">
              <span className={field}>Adresse du PBS sur Tailscale (hôtes du réseau Tailscale)</span>
              <input className="input font-mono text-xs" value={form.tailscaleUrl ?? ''} onChange={(e) => set({ tailscaleUrl: e.target.value.trim() })} placeholder="https://100.65.214.55:8007" spellCheck={false} />
              <span className="mt-1 block text-xs text-zinc-500">Même certificat (empreinte ci-dessus). Vide : ces hôtes ne sauvegardent pas.</span>
            </label>
            <label className="block">
              <span className={field}>Image du client (hôtes sans client installé)</span>
              <input className="input font-mono text-xs" value={form.clientImage ?? ''} onChange={(e) => set({ clientImage: e.target.value.trim() })} placeholder="mathmath350/pbs-client:latest" spellCheck={false} />
            </label>
          </div>
        </div>
        <TokenAside
          title="Créer le jeton sur le PBS"
          intro={
            <>
              Jeton de l'utilisateur <code>homelab@pbs</code>, rôle <b>DatastoreAudit</b> sur <code>/datastore</code> (lecture seule), donné à l'utilisateur <b>et</b> au jeton :
              les droits d'un jeton PBS sont l'intersection des siens et de ceux de son utilisateur.
            </>
          }
          setup={
            <TokenSetup
              where="du PBS"
              tokenId={form.tokenId}
              onTokenIdChange={(tokenId) => set({ tokenId })}
              request={() => ({ kind: 'pbs' })}
              onDone={() => {
                qc.invalidateQueries({ queryKey: ['settings', 'pbs'] });
                set({ tokenSecret: undefined });
              }}
            />
          }
          manualScript={pbsSetup(form.tokenId)}
          manualUi={
            <>
              Ou dans l'interface du PBS, Configuration › Contrôle d'accès : <b>Gestion des utilisateurs</b> › Ajouter (realm <code>pbs</code>), <b>Jetons API</b> › Ajouter, puis{' '}
              <b>Permissions</b> : « Permission utilisateur » et « Permission de jeton API », chemin <code>/datastore</code>, rôle <code>DatastoreAudit</code>, Propager coché.
            </>
          }
        />
      </div>
    </Modal>
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
