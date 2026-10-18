import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, History, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { api, type Host, type NextcloudDiscovery, type NextcloudSettings } from '../lib/api';
import { formatBytes, keepText } from '../lib/backups';
import { keys } from '../lib/queries';
import { useToast } from '../lib/toast';
import { field } from './ProxmoxServer';
import { Button, ConfirmModal, Modal, ProgressBar, Spinner } from './ui';

const MAX_KEEP = 30;

// Plugin Nextcloud AIO of a host (hub/src/nextcloud.ts): the agent finds the instance and its users, the
// admin chooses a datastore per line (none: not backed up), the hub generates the jobs. Those jobs are
// changed or removed here only.
export function NextcloudPluginModal({ host, open, onClose }: { host: Host; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: view } = useQuery({ queryKey: ['backup-jobs', host.id], queryFn: () => api.hostBackupJobs(host.id), enabled: open });
  const [disco, setDisco] = useState<{ result?: NextcloudDiscovery; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<NextcloudSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // settings of before the disconnection of the PBS, prefilled: what could not be taken again
  const [restoreNotes, setRestoreNotes] = useState<string[] | null>(null);

  const discover = async (workDir?: string) => {
    setLoading(true);
    try {
      const d = await api.discoverNextcloud(host.id, workDir);
      setDisco({ result: d });
      return d;
    } catch (err) {
      setDisco({ error: (err as Error).message });
      return null;
    } finally {
      setLoading(false);
    }
  };

  // at opening: what the agent finds, then the form from the settings
  useEffect(() => {
    if (!open || !view) return;
    let gone = false;
    (async () => {
      const previous = !view.nextcloudSettings ? view.nextcloudPrevious : null;
      const s = view.nextcloudSettings ?? previous;
      const d = await discover(s?.workDir);
      if (gone) return;
      if (previous) {
        // recalibrated on the instance and the datastores of now
        const known = (st: string | null) => (st && view.datastores.includes(st) ? st : null);
        const notes = [
          ...previous.users.filter((x) => d && !d.users.some((u) => u.id === x.id)).map((x) => `utilisateur ${x.id} disparu de Nextcloud : retiré`),
          ...[previous.database, previous.config, ...previous.users.map((u) => u.store)]
            .filter((st, i, all): st is string => !!st && !view.datastores.includes(st) && all.indexOf(st) === i)
            .map((st) => `datastore ${st} absent du PBS : à choisir à nouveau`),
        ];
        setRestoreNotes(notes);
        setForm({
          workDir: previous.workDir,
          keep: previous.keep,
          schedule: previous.schedule,
          enabled: previous.enabled,
          database: known(previous.database),
          config: known(previous.config),
          users: previous.users.filter((x) => (!d || d.users.some((u) => u.id === x.id)) && known(x.store)),
        });
        return;
      }
      setForm({
        workDir: s?.workDir ?? (d?.composeFiles[0] ? `${d.composeFiles[0].replace(/\/[^/]+$/, '')}/backup-homelab` : ''),
        keep: s?.keep ?? 1,
        schedule: s?.schedule ?? '02:30',
        enabled: s?.enabled ?? true,
        // no default datastore: not backed up until chosen
        database: s?.database ?? null,
        config: s?.config ?? null,
        // users still known to Nextcloud
        users: (s?.users ?? []).filter((x) => !d || d.users.some((u) => u.id === x.id)),
      });
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!view]);

  const close = () => {
    setForm(null);
    setDisco(null);
    setRestoreNotes(null);
    onClose();
  };

  // the settings of before the disconnection forgotten (only the cache: direct)
  const forget = async () => {
    setBusy(true);
    try {
      await api.dropCachedNextcloud(host.id);
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
      close();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const d = disco?.result;
  const stores = view?.datastores ?? [];
  const userStore = (id: string) => form?.users.find((u) => u.id === id)?.store ?? null;
  const setUser = (id: string, store: string | null) =>
    form && setForm({ ...form, users: store ? [...form.users.filter((u) => u.id !== id), { id, store }] : form.users.filter((u) => u.id !== id) });
  const set = (patch: Partial<NextcloudSettings>) => form && setForm({ ...form, ...patch });

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const r = await api.saveNextcloud(host.id, form);
      toast.success(`Plugin Nextcloud enregistré : ${r.created} job${r.created > 1 ? 's' : ''} créé${r.created > 1 ? 's' : ''}, ${r.updated} mis à jour, ${r.removed} supprimé${r.removed > 1 ? 's' : ''}`);
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
      qc.invalidateQueries({ queryKey: keys.backups });
      close();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      const r = await api.deleteNextcloud(host.id);
      toast.success(`Plugin Nextcloud supprimé (${r.removed} job${r.removed > 1 ? 's' : ''})`);
      qc.invalidateQueries({ queryKey: ['backup-jobs', host.id] });
      qc.invalidateQueries({ queryKey: keys.backups });
      setRemoving(false);
      close();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const select = (value: string | null, onChange: (v: string | null) => void, disabled?: boolean) => (
    <select className="input w-36 py-1 text-xs" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— non sauvegardé</option>
      {stores.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );

  const usersOff = d?.users.filter((u) => !userStore(u.id) && u.exists && !u.error) ?? [];

  return (
    <Modal
      open={open}
      onClose={close}
      wide="xl"
      title={`Nextcloud AIO · ${host.name}`}
      footer={
        <>
          {view?.nextcloudSettings && (
            <Button variant="ghost" icon={Trash2} className="mr-auto" onClick={() => setRemoving(true)}>Supprimer le plugin</Button>
          )}
          {restoreNotes && (
            <Button variant="ghost" icon={X} className="mr-auto" disabled={busy} onClick={() => void forget()} title="Oublier la configuration d’avant la déconnexion du PBS">
              Oublier cette configuration
            </Button>
          )}
          <Button onClick={close}>Annuler</Button>
          <Button variant="primary" icon={Save} loading={busy} disabled={!form || !d || !host.online} onClick={save}>Enregistrer</Button>
        </>
      }
    >
      {!view ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : loading && !d ? (
        <ProgressBar className="px-2 py-8" label={`Lecture de l'instance Nextcloud sur ${host.name} : conteneurs, base, utilisateurs et leurs répertoires…`} />
      ) : disco?.error ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {disco.error}
          </p>
          <Button icon={RefreshCw} loading={loading} onClick={() => discover(form?.workDir)}>Réessayer</Button>
        </div>
      ) : d && form ? (
        <div className="space-y-5">
          {restoreNotes && (
            <div className="rounded-md border border-dashed border-amber-500/50 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
              <p className="flex items-center gap-2 font-medium">
                <History className="h-4 w-4 shrink-0" /> Configuration d’avant la déconnexion du PBS : vérifier puis Enregistrer pour la restaurer.
              </p>
              {restoreNotes.length > 0 && (
                <ul className="mt-1 list-disc pl-6">
                  {restoreNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="text-xs text-muted">
            Nextcloud {d.version} · base <span className="font-mono">{d.database}</span> ({d.dbSize < 0 ? '?' : formatBytes(d.dbSize)}) · données{' '}
            <span className="font-mono">{d.dataDir}</span> · {d.dbTools}
            <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={() => discover(form.workDir)} title="Relire l'instance sur l'hôte" />
          </p>

          {/* Relire: the table stays, the bar says it is being read again */}
          {loading && <ProgressBar label="Relecture de l'instance…" />}
          {/* the list scrolls, the rest of the window stays in place */}
          <div className="max-h-[40vh] overflow-y-auto rounded-md border border-line">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-raised text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Élément</th>
                  <th className="px-3 py-2 font-medium">Contenu</th>
                  <th className="px-3 py-2 font-medium">Datastore</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <tr>
                  <td className="px-3 py-2 text-zinc-100">Base</td>
                  <td className="px-3 py-2 text-xs text-muted">pg_dump de {d.database} et rôles, dans le conteneur {d.containers.database}</td>
                  <td className="px-3 py-2">{select(form.database, (v) => set({ database: v }))}</td>
                </tr>
                <tr>
                  <td className="px-3 py-2 text-zinc-100">Configuration</td>
                  <td className="px-3 py-2 text-xs text-muted">
                    config/, {d.composeFiles.length ? 'docker-compose.yml, ' : ''}fichiers du répertoire de données, appdata_{d.instanceId} sans preview, appstore, js
                  </td>
                  <td className="px-3 py-2">{select(form.config, (v) => set({ config: v }))}</td>
                </tr>
                {d.users.map((u) => {
                  const off = !!u.error || !u.exists;
                  return (
                    <tr key={u.id}>
                      <td className="px-3 py-2 text-zinc-100">
                        {u.id}
                        {u.name !== u.id && <span className="text-muted"> · {u.name}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted">
                        {u.error ? <span className="text-amber-400">{u.error}</span> : !u.exists ? 'pas encore de répertoire (jamais connecté)' : <span className="font-mono">{u.path}</span>}
                      </td>
                      <td className="px-3 py-2">{select(userStore(u.id), (v) => setUser(u.id, v), off && !userStore(u.id))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {usersOff.length > 0 && (
            <p className="flex items-center gap-2 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Non sauvegardé{usersOff.length > 1 ? 's' : ''} : {usersOff.map((u) => u.id).join(', ')}
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block sm:col-span-3">
              <span className={field}>Répertoire de travail (dumps et copie de la configuration)</span>
              <input className="input font-mono text-xs" value={form.workDir} onChange={(e) => set({ workDir: e.target.value.trim() })} placeholder="/mnt/user/docker/nextcloud-aio/backup-homelab" />
              <span className="mt-1 block text-xs text-muted">
                Sous-répertoires database/ et config/, refaits à chaque sauvegarde. Place libre : {d.free < 0 ? 'inconnue' : formatBytes(d.free)}. À exclure des autres sauvegardes du
                même disque.
              </span>
            </label>
            <label className="block">
              <span className={field}>Planification</span>
              <input className="input" value={form.schedule} onChange={(e) => set({ schedule: e.target.value })} placeholder="02:30" />
              <span className="mt-1 block text-xs text-muted">Commune aux jobs : l'agent les enchaîne.</span>
            </label>
            <label className="block">
              <span className={field}>Dumps gardés sur l'hôte</span>
              <input
                className="input w-28"
                type="number"
                min={0}
                max={MAX_KEEP}
                value={form.keep}
                onChange={(e) => set({ keep: Math.max(0, Math.min(MAX_KEEP, Math.trunc(Number(e.target.value) || 0))) })}
              />
              <span className="mt-1 block text-xs text-muted">{keepText(form.keep)}</span>
            </label>
            <label className="flex items-center gap-2 self-start pt-6 text-sm text-zinc-300">
              <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              Activé
            </label>
          </div>
          <p className="text-xs text-muted">
            Les jobs générés sont rattachés à l'hôte et ne se modifient qu'ici. Un utilisateur décoché : son job est supprimé, ses snapshots restent sur le PBS.
          </p>
        </div>
      ) : null}
      <ConfirmModal open={removing} onClose={() => setRemoving(false)} onConfirm={remove} title="Supprimer le plugin Nextcloud" confirmLabel="Supprimer" danger loading={deleting}>
        Tous les jobs générés par le plugin sont supprimés (base, configuration, utilisateurs). Les snapshots déjà faits restent sur le PBS (groupes orphelins).
      </ConfirmModal>
    </Modal>
  );
}
