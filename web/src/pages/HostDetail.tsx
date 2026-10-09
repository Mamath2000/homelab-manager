import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowLeft, ArrowUpCircle, Cpu, History, KeyRound, Lock, Package, Pencil, RefreshCw, RotateCw, Server, ShieldAlert, Terminal, Trash2 } from 'lucide-react';
import { InstallInstructions } from '../components/InstallInstructions';
import { JobConsole, JobStatusIcon } from '../components/JobConsole';
import { RebootTag } from '../components/Reboot';
import { useToast } from '../components/Toast';
import { Badge, Button, Checkbox, ConfirmModal, Empty, Modal, PageHeader, Panel, Spinner, Tag } from '../components/ui';
import { api, type Host } from '../lib/api';
import { actionLabel, dateTime, timeAgo, uptime } from '../lib/format';
import { useHost, useHostJobs, useRunJob, useUpdateHostCache } from '../lib/queries';
import { connection, connectionMeta, listsStale, osLabel } from '../lib/status';

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-zinc-200">{children}</dd>
    </div>
  );
}

function EditModal({ host, open, onClose }: { host: Host; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(host.name);
  const [group, setGroup] = useState(host.group);
  const [busy, setBusy] = useState(false);
  const upsert = useUpdateHostCache();
  const toast = useToast();
  useEffect(() => {
    if (open) {
      setName(host.name);
      setGroup(host.group);
    }
  }, [open, host.name, host.group]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      upsert(await api.updateHost(host.id, { name, group }));
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Modifier l'hôte">
      <form onSubmit={save} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Nom</span>
          <input className="input" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Groupe</span>
          <input className="input" maxLength={64} value={group} onChange={(e) => setGroup(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="primary" loading={busy}>Enregistrer</Button>
        </div>
      </form>
    </Modal>
  );
}

function PackagesPanel({ host }: { host: Host }) {
  const run = useRunJob();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const pkgs = host.apt?.upgradable ?? [];
  const rebootPkgs = pkgs.filter((p) => p.reboot).map((p) => p.name);
  const selectedReboot = rebootPkgs.filter((n) => selected.has(n));

  // drop selections that are no longer upgradable after a refresh
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((n) => pkgs.some((p) => p.name === n))));
  }, [host.apt?.checkedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = pkgs.length > 0 && selected.size === pkgs.length;
  const toggle = (n: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(n);
      else next.delete(n);
      return next;
    });

  return (
    <Panel
      title={<>Paquets à mettre à jour <span className="text-muted">({pkgs.length})</span></>}
      icon={Package}
      bodyClassName=""
      actions={
        selected.size > 0 && (
          <Button size="sm" variant="primary" icon={ArrowUpCircle} disabled={!host.online} onClick={() => setConfirm(true)}>
            Mettre à jour la sélection ({selected.size})
          </Button>
        )
      }
    >
      {(host.apt?.rebootRequired || rebootPkgs.length > 0 || (host.apt?.held.length ?? 0) > 0 || listsStale(host)) && (
        <div className="space-y-2 border-b border-line px-4 py-3 text-sm">
          {host.apt?.rebootRequired && (
            <p className="flex flex-wrap items-center gap-2 text-red-300">
              <RotateCw className="h-4 w-4" /> Redémarrage requis
              {host.apt.rebootPkgs.length > 0 && <span className="text-xs text-muted">({host.apt.rebootPkgs.join(', ')})</span>}
            </p>
          )}
          {rebootPkgs.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-amber-300">
              <RotateCw className="h-4 w-4" /> Redémarrage à prévoir après la mise à jour de : {rebootPkgs.join(', ')}
            </p>
          )}
          {(host.apt?.held.length ?? 0) > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-zinc-300">
              <Lock className="h-4 w-4 text-muted" /> Paquets bloqués (hold) :
              {host.apt!.held.map((p) => <Tag key={p}>{p}</Tag>)}
            </p>
          )}
          {listsStale(host) && (
            <p className="flex items-center gap-2 text-violet-300">
              <ShieldAlert className="h-4 w-4" /> Listes de paquets périmées ({timeAgo(host.apt?.listsUpdatedAt)}) : lance une recherche.
            </p>
          )}
        </div>
      )}
      {!host.apt ? (
        <Empty icon={Package} title="Pas encore de relevé">L'agent n'a pas encore envoyé l'état des paquets.</Empty>
      ) : pkgs.length === 0 ? (
        <Empty icon={Package} title="Tout est à jour">Dernière vérification {timeAgo(host.apt.listsUpdatedAt)}.</Empty>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b border-line bg-panel">
              <tr>
                <th className="th w-10"><Checkbox label="Tout sélectionner" checked={all} indeterminate={selected.size > 0} onChange={(on) => setSelected(on ? new Set(pkgs.map((p) => p.name)) : new Set())} /></th>
                <th className="th">Paquet</th>
                <th className="th">Installé</th>
                <th className="th">Disponible</th>
                <th className="th">Dépôt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {pkgs.map((p) => (
                <tr key={p.name} className="cursor-pointer hover:bg-raised/50" onClick={() => toggle(p.name, !selected.has(p.name))}>
                  <td className="td"><Checkbox label={p.name} checked={selected.has(p.name)} onChange={(on) => toggle(p.name, on)} /></td>
                  <td className="td">
                    <span className="font-medium text-zinc-100">{p.name}</span>
                    {p.security && <Badge tone="bad" className="ml-2">sécurité</Badge>}
                    {p.reboot && <RebootTag />}
                  </td>
                  <td className="td font-mono text-xs text-zinc-500">{p.current}</td>
                  <td className="td font-mono text-xs text-emerald-300">{p.candidate}</td>
                  <td className="td text-xs text-muted">{p.repo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Mettre à jour ${selected.size} paquet(s)`}
        confirmLabel="Mettre à jour"
        loading={run.isPending}
        onConfirm={() =>
          run.mutate({ hostId: host.id, action: 'apt_upgrade', packages: [...selected] }, { onSuccess: () => { setConfirm(false); setSelected(new Set()); } })
        }
      >
        <div className="flex flex-wrap gap-1.5">{[...selected].map((n) => <Tag key={n}>{n}</Tag>)}</div>
        {selectedReboot.length > 0 && <p className="mt-3 text-amber-300">Redémarrage à prévoir ensuite ({selectedReboot.join(', ')}).</p>}
      </ConfirmModal>
    </Panel>
  );
}

export function HostDetail() {
  const { id = '' } = useParams();
  const { data: host, isLoading } = useHost(id);
  const { data: jobs } = useHostJobs(id);
  const run = useRunJob();
  const navigate = useNavigate();
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmUpgrade, setConfirmUpgrade] = useState(false);
  const [install, setInstall] = useState<{ command: string | null } | null>(null);
  const [confirmToken, setConfirmToken] = useState(false);

  const shownJob = jobId ?? jobs?.[0]?.id ?? null;
  const running = useMemo(() => jobs?.some((j) => j.status === 'running'), [jobs]);

  if (isLoading) return <div className="flex justify-center p-20"><Spinner /></div>;
  if (!host) return <Empty icon={Server} title="Hôte introuvable"><Link className="text-emerald-400" to="/hosts">Retour aux hôtes</Link></Empty>;

  const c = connection(host);
  const startJob = (action: 'apt_update' | 'apt_upgrade') =>
    run.mutate({ hostId: host.id, action }, { onSuccess: (j) => { setJobId(j.id); setConfirmUpgrade(false); } });

  const regenerate = async () => {
    try {
      const r = await api.regenerateToken(host.id);
      setConfirmToken(false);
      setInstall({ command: r.installCommand });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <>
      <Link to="/hosts" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" /> Hôtes
      </Link>
      <PageHeader
        icon={Server}
        title={host.name}
        actions={
          <>
            <Button icon={RefreshCw} disabled={!host.online || running} loading={run.isPending && run.variables?.action === 'apt_update'} onClick={() => startJob('apt_update')}>
              Rechercher les MAJ
            </Button>
            <Button icon={ArrowUpCircle} variant="primary" disabled={!host.online || running || !host.aptSummary?.upgradable} onClick={() => setConfirmUpgrade(true)}>
              Tout mettre à jour
            </Button>
            <Button icon={Pencil} variant="ghost" title="Modifier" onClick={() => setEditing(true)} />
            <Button icon={KeyRound} variant="ghost" title="Nouveau token" onClick={() => setConfirmToken(true)} />
            <Button icon={Trash2} variant="ghost" title="Supprimer" className="hover:text-red-400" onClick={() => setDeleting(true)} />
          </>
        }
      >
        <Badge tone={connectionMeta[c].tone}>{connectionMeta[c].label}</Badge>
        {host.group && <Tag>{host.group}</Tag>}
      </PageHeader>

      {c === 'pending' && (
        <Panel title="Installer l'agent" icon={Terminal} className="mb-5">
          <p className="mb-3 text-sm text-zinc-300">Cet hôte n'a encore jamais contacté le hub. Le token n'étant affiché qu'à la création, génère une nouvelle commande si besoin.</p>
          <Button icon={KeyRound} onClick={regenerate}>Générer la commande d'installation</Button>
        </Panel>
      )}

      <div className="grid gap-5 xl:grid-cols-[340px_1fr]">
        <Panel title="Système" icon={Cpu}>
          <dl className="-my-2 divide-y divide-line">
            <InfoRow label="Hostname">{host.info?.hostname ?? '—'}</InfoRow>
            <InfoRow label="OS">{osLabel(host) ?? '—'}</InfoRow>
            <InfoRow label="Noyau"><span className="font-mono text-xs">{host.info?.kernel ?? '—'}</span></InfoRow>
            <InfoRow label="Architecture">{host.info?.arch ?? '—'}</InfoRow>
            <InfoRow label="Virtualisation">{host.info?.virt ?? '—'}</InfoRow>
            <InfoRow label="IP"><span className="font-mono text-xs">{host.info?.ips?.join(', ') || '—'}</span></InfoRow>
            <InfoRow label="Uptime">{host.info ? uptime(host.info.uptime) : '—'}</InfoRow>
            <InfoRow label="Agent">{host.agentVersion ?? '—'}</InfoRow>
            <InfoRow label="Vu">{host.online ? 'connecté' : timeAgo(host.lastSeenAt)}</InfoRow>
            <InfoRow label="Listes apt">{host.apt ? dateTime(host.apt.listsUpdatedAt) : '—'}</InfoRow>
          </dl>
        </Panel>
        <PackagesPanel host={host} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[340px_1fr]">
        <Panel title="Historique" icon={History} bodyClassName="max-h-[420px] overflow-auto">
          {!jobs?.length ? (
            <p className="p-4 text-sm text-muted">Aucune tâche.</p>
          ) : (
            <ul className="divide-y divide-line">
              {jobs.map((j) => (
                <li key={j.id}>
                  <button onClick={() => setJobId(j.id)} className={clsx('flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-raised/50', shownJob === j.id && 'bg-raised')}>
                    <JobStatusIcon status={j.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-zinc-200">{actionLabel[j.action]}{j.packages.length > 0 && ` (${j.packages.length})`}</span>
                      <span className="text-xs text-muted">{timeAgo(j.createdAt)}{j.trigger === 'schedule' && ' · planifiée'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Console" icon={Terminal}>
          {shownJob ? <JobConsole jobId={shownJob} height="h-[360px]" /> : <p className="text-sm text-muted">Les sorties des tâches s'affichent ici en direct.</p>}
        </Panel>
      </div>

      <EditModal host={host} open={editing} onClose={() => setEditing(false)} />
      <ConfirmModal open={confirmUpgrade} onClose={() => setConfirmUpgrade(false)} title={`Mettre à jour ${host.name}`} confirmLabel="Lancer apt-get upgrade" loading={run.isPending} onConfirm={() => startJob('apt_upgrade')}>
        {host.aptSummary?.upgradable} paquet(s) vont être mis à jour, dont {host.aptSummary?.security} de sécurité. Les fichiers de configuration modifiés localement sont conservés.
        {!!host.aptSummary?.rebootPending && <p className="mt-3 text-amber-300">Un redémarrage sera nécessaire ensuite (noyau, microcode ou bibliothèques système).</p>}
      </ConfirmModal>
      <ConfirmModal open={confirmToken} onClose={() => setConfirmToken(false)} title="Générer un nouveau token" confirmLabel="Générer" danger={c !== 'pending'} onConfirm={regenerate}>
        {c === 'pending' ? "Une nouvelle commande d'installation va être générée." : "L'agent actuel sera déconnecté et devra être réinstallé avec le nouveau token."}
      </ConfirmModal>
      <ConfirmModal
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Supprimer ${host.name}`}
        confirmLabel="Supprimer"
        danger
        onConfirm={async () => {
          try {
            await api.deleteHost(host.id);
            navigate('/hosts');
          } catch (err) {
            toast.error((err as Error).message);
          }
        }}
      >
        L'hôte et son historique seront supprimés et l'agent déconnecté. Pour désinstaller l'agent :
        <pre className="mt-2 overflow-x-auto rounded border border-line bg-black/40 p-2 font-mono text-xs text-zinc-300">curl -fsSL {window.location.origin}/install.sh | sh -s -- --uninstall</pre>
      </ConfirmModal>
      <Modal open={!!install} onClose={() => setInstall(null)} title={`Installer l'agent sur ${host.name}`} wide>
        {install && <InstallInstructions command={install.command} />}
      </Modal>
    </>
  );
}
