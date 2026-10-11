import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, Fingerprint, Plug, Save } from 'lucide-react';
import { api, type PbsSettingsInput } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useToast } from '../lib/toast';
import { Button, CopyField, Panel, Spinner } from './ui';

const PBS_SETUP = `# utilisateur dédié, sans mot de passe : il ne sert pas à se connecter
proxmox-backup-manager user create homelab@pbs
# son jeton : noter le secret affiché, il n'est montré qu'une fois
proxmox-backup-manager user generate-token homelab@pbs monitor
# lecture seule sur tous les datastores, pour l'utilisateur ET le jeton
proxmox-backup-manager acl update /datastore DatastoreAudit --auth-id homelab@pbs
proxmox-backup-manager acl update /datastore DatastoreAudit --auth-id 'homelab@pbs!monitor'
# contrôle : doit lister Datastore.Audit
proxmox-backup-manager user permissions 'homelab@pbs!monitor' --path /datastore`;

// Proxmox Backup Server followed through its API (Paramètres > Sauvegardes).
export function BackupSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'pbs'], queryFn: api.pbsSettings });
  // local draft once edited, server values until then; the secret is never sent back by the hub
  const [draft, setDraft] = useState<PbsSettingsInput | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'fp' | null>(null);
  const [test, setTest] = useState<{ level: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  if (!data) return <div className="flex justify-center p-10"><Spinner /></div>;
  const form: PbsSettingsInput = draft ?? { enabled: data.enabled, url: data.url, fingerprint: data.fingerprint, tokenId: data.tokenId, staleHours: data.staleHours };
  const set = (patch: Partial<PbsSettingsInput>) => setDraft({ ...form, ...patch });
  // an empty secret field keeps the stored one
  const body = (): PbsSettingsInput => {
    const { tokenSecret, ...rest } = form;
    return tokenSecret ? { ...rest, tokenSecret } : rest;
  };

  const save = async () => {
    setBusy('save');
    try {
      qc.setQueryData(['settings', 'pbs'], await api.savePbsSettings(body()));
      qc.invalidateQueries({ queryKey: ['backups'] });
      setDraft(null);
      toast.success(form.enabled ? 'Enregistré : relevé du PBS en cours' : 'Enregistré');
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
      const r = await api.testPbsSettings(body());
      if (!r.ok) setTest({ level: 'error', text: r.error ?? 'échec' });
      // the PBS filters the list by permission instead of answering 403
      else if (!r.datastores?.length) setTest({ level: 'warn', text: 'Connexion réussie mais aucun datastore visible : vérifier DatastoreAudit sur /datastore pour l’utilisateur ET le jeton' });
      else setTest({ level: 'ok', text: `Connexion réussie · datastores : ${r.datastores.join(', ')}` });
    } catch (err) {
      setTest({ level: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const fetchFp = async () => {
    setBusy('fp');
    try {
      set({ fingerprint: (await api.pbsFingerprint(form.url)).fingerprint });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const field = 'mb-1.5 block text-xs font-medium text-muted';
  return (
    <Panel title="Proxmox Backup Server" icon={DatabaseBackup} actions={<Button size="sm" variant="primary" icon={Save} loading={busy === 'save'} onClick={save}>Enregistrer</Button>}>
      <div className="grid gap-6 text-sm lg:grid-cols-2">
        <div className="space-y-4">
          <p className="text-muted">
            Le hub lit l'API du PBS avec un jeton en lecture seule : rien n'est installé sur les hôtes. Il relève les groupes de sauvegarde toutes les 15 minutes et les
            rattache aux hôtes.
          </p>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line bg-raised/40 p-4">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="mt-0.5 h-4 w-4 accent-emerald-500" />
            <span>
              <span className="block font-medium text-zinc-100">Suivre les sauvegardes</span>
              <span className="mt-1 block text-xs text-muted">
                {data.polledAt ? <>Dernier relevé {timeAgo(data.polledAt)}{data.pollError ? <span className="text-red-400"> · {data.pollError}</span> : ' · réussi'}</> : 'Jamais relevé.'}
              </span>
            </span>
          </label>
          <label className="block">
            <span className={field}>Adresse du PBS</span>
            <input className="input" value={form.url} onChange={(e) => set({ url: e.target.value.trim() })} placeholder="https://192.168.100.20:8007" spellCheck={false} />
          </label>
          <div>
            <span className={field}>Empreinte du certificat (SHA-256)</span>
            <div className="flex gap-2">
              <input className="input font-mono text-xs" value={form.fingerprint} onChange={(e) => set({ fingerprint: e.target.value.trim() })} placeholder="AB:CD:… (vide : autorités système)" spellCheck={false} />
              <Button icon={Fingerprint} loading={busy === 'fp'} disabled={!form.url} onClick={fetchFp} title="Lit l'empreinte du certificat présenté par le PBS">Récupérer</Button>
            </div>
            <p className="mt-1 text-xs text-muted">
              Le certificat du PBS est auto-signé : son empreinte est épinglée. Compare-la avec celle affichée dans le PBS (Tableau de bord › Afficher l'empreinte) avant d'enregistrer.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className={field}>Identifiant du jeton</span>
              <input className="input font-mono text-xs" value={form.tokenId} onChange={(e) => set({ tokenId: e.target.value.trim() })} placeholder="homelab@pbs!monitor" spellCheck={false} />
            </label>
            <label className="block">
              <span className={field}>Secret du jeton</span>
              <input
                className="input font-mono text-xs"
                type="password"
                autoComplete="off"
                value={form.tokenSecret ?? ''}
                onChange={(e) => set({ tokenSecret: e.target.value.trim() })}
                placeholder={data.hasSecret ? '•••••••• (inchangé)' : 'xxxxxxxx-xxxx-…'}
              />
            </label>
          </div>
          <label className="block max-w-xs">
            <span className={field}>Seuil de retard par défaut (heures)</span>
            <input className="input" type="number" min={1} max={1440} value={form.staleHours} onChange={(e) => set({ staleHours: Math.max(1, Number(e.target.value) || 26) })} />
            <span className="mt-1 block text-xs text-muted">
              Une sauvegarde est en retard après 1,5 × son rythme, appris de ses derniers snapshots ou, à défaut, de la rétention du PBS. Ce seuil sert
              quand aucun des deux n'est connu ; il peut aussi être fixé sauvegarde par sauvegarde.
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button icon={Plug} loading={busy === 'test'} disabled={!form.url || !form.tokenId} onClick={runTest}>Tester la connexion</Button>
            {test && <span className={{ ok: 'text-xs text-emerald-400', warn: 'text-xs text-amber-400', error: 'text-xs text-red-400' }[test.level]}>{test.text}</span>}
          </div>
        </div>
        <aside className="space-y-2 self-start rounded-md border border-line bg-raised/40 p-4 text-xs text-muted">
          <p className="font-medium text-zinc-100">Créer le jeton sur le PBS</p>
          <p>
            Les droits d'un jeton PBS sont l'intersection des siens et de ceux de son utilisateur : le rôle <b>DatastoreAudit</b> sur <code>/datastore</code> doit être
            donné à l'utilisateur <b>et</b> au jeton. En ligne de commande sur le PBS :
          </p>
          <CopyField multiline value={PBS_SETUP} />
          <p>
            Ou dans l'interface du PBS, Configuration › Contrôle d'accès : onglet <b>Gestion des utilisateurs</b> › Ajouter (realm <code>pbs</code>), onglet{' '}
            <b>Jetons API</b> › Ajouter sur cet utilisateur (le secret n'est affiché qu'une fois), puis onglet <b>Permissions</b> : « Ajouter › Permission utilisateur »
            et « Ajouter › Permission de jeton API », chemin <code>/datastore</code>, rôle <code>DatastoreAudit</code>, Propager coché.
          </p>
        </aside>
      </div>
    </Panel>
  );
}
