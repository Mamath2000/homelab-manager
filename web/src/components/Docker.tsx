import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowUpCircle, Container, Eye, EyeOff, Play, RefreshCcw, RefreshCw, RotateCw, ScrollText, Square } from 'lucide-react';
import { api, type DockerStack, type Host, type ImageUpdate, type StackAction } from '../lib/api';
import { useMe } from '../lib/auth';
import { hostLogsPath } from '../lib/hostLogs';
import { timeAgo } from '../lib/format';
import { keys, useRunJob } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import { imageUpdateMeta, stackMeta, stackPath } from '../lib/status';
import { Badge, Button, ConfirmModal, IconGroup, Panel, Tag } from './ui';

export function StackStatusBadge({ stack }: { stack: Pick<DockerStack, 'managed' | 'status' | 'running' | 'total'> }) {
  if (!stack.managed) {
    return (
      <span title="Gérée en dehors de Homelab Manager : ni état ni action suivis">
        <Badge tone="neutral">Non managée</Badge>
      </span>
    );
  }
  const m = stackMeta[stack.status];
  return (
    <Badge tone={m.tone}>
      {m.label}
      {stack.status !== 'down' && <span className="tabular-nums opacity-80">· {stack.running}/{stack.total}</span>}
    </Badge>
  );
}

export function ImageUpdateBadge({ update, count }: { update: ImageUpdate; count?: number }) {
  const m = imageUpdateMeta[update];
  return (
    <span title={m.hint}>
      <Badge tone={m.tone}>{update === 'available' && count ? `${count} MAJ` : m.label}</Badge>
    </span>
  );
}

// `confirm` = the action asks for a confirmation before starting (stop only).
const actionText: Record<StackAction, { label: string; icon: typeof Play; confirm?: (what: string) => string }> = {
  docker_up: { label: 'Démarrer', icon: Play },
  docker_stop: { label: 'Arrêter', icon: Square, confirm: (w) => `docker compose stop sur ${w} : les conteneurs sont arrêtés, pas supprimés.` },
  docker_restart: { label: 'Redémarrer', icon: RotateCw },
  docker_update: { label: 'Mettre à jour', icon: ArrowUpCircle },
  docker_recreate: { label: 'Recréer', icon: RefreshCcw },
};

// Recreate is offered to a stack whose containers do not send their journals yet (created before the collector)
const recreateOffered = (host: Host, stack: DockerStack, service?: string) => !service && stack.logs === 'recreate' && host.capabilities.includes('docker_recreate');

// Journals of the containers of a stack, while the collector is set up on the host (homelab#346)
export function StackLogsBadge({ stack }: { stack: Pick<DockerStack, 'logs'> }) {
  if (stack.logs === 'followed') {
    return (
      <span title="Chaque conteneur de la stack envoie ses journaux">
        <Badge tone="ok">Suivis</Badge>
      </span>
    );
  }
  if (stack.logs === 'recreate') {
    return (
      <span title="Des conteneurs créés avant la mise en place du suivi n'envoient rien : recréer la stack">
        <Badge tone="warn">À recréer</Badge>
      </span>
    );
  }
  if (stack.logs === 'ignored') {
    return (
      <span title="Journaux volontairement non suivis pour cette stack">
        <Badge tone="neutral">Non suivis</Badge>
      </span>
    );
  }
  return null;
}

// The badge of the journals of a stack, and (admins) the choice to leave it out on purpose, or to follow it again: a stack
// the admin does not want in the journals is « not followed », not « to recreate ». Only what is shown, nothing on the host.
function StackLogsCell({ host, stack }: { host: Host; stack: DockerStack }) {
  const { canSettings } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = stack.logs === 'recreate' ? { follow: false, icon: EyeOff, title: 'Ne pas suivre les journaux de cette stack (plus « à recréer »)' } : stack.logs === 'ignored' ? { follow: true, icon: Eye, title: 'Suivre de nouveau les journaux de cette stack' } : null;
  const run = async (follow: boolean) => {
    setBusy(true);
    try {
      await api.setStackLogFollow(host.id, stack.name, follow);
      await qc.invalidateQueries({ queryKey: keys.hosts });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <StackLogsBadge stack={stack} />
      {canSettings && toggle && (
        <button type="button" disabled={busy} title={toggle.title} aria-label={toggle.title} onClick={() => void run(toggle.follow)} className="rounded p-0.5 text-zinc-500 hover:bg-raised hover:text-zinc-200 disabled:opacity-40">
          <toggle.icon className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  );
}

// Buttons for a stack, or one of its services; only stopping asks for a confirmation.
// `compact`: icon block of a table row, always the 4 actions (greyed when not possible).
export function StackActions({
  host,
  stack,
  service,
  disabled,
  compact,
  onStarted,
}: {
  host: Host;
  stack: DockerStack;
  service?: string;
  disabled?: boolean;
  compact?: boolean;
  onStarted?: (jobId: string) => void;
}) {
  const { canWrite } = useMe();
  const run = useRunJob();
  const [confirm, setConfirm] = useState<StackAction | null>(null);
  if (!canWrite) return null;
  // unmanaged: read-only, no action at all (the row keeps a greyed block)
  if (!stack.managed && !compact) return null;
  const what = service ? `le service ${service} de ${stack.name}` : `la stack ${stack.name}`;
  const off = disabled || !host.online;
  const recreate = recreateOffered(host, stack, service);
  const all: StackAction[] = ['docker_up', 'docker_restart', 'docker_stop', 'docker_update', ...(recreate ? (['docker_recreate'] as const) : [])];
  const actions: StackAction[] = stack.status === 'down' ? ['docker_up'] : all;
  const highlight = (a: StackAction) => (a === 'docker_update' && stack.updates > 0 && !service) || a === 'docker_recreate';
  const start = (a: StackAction) =>
    run.mutate(
      { hostId: host.id, action: a, target: { stack: stack.name, service } },
      {
        onSuccess: (j) => {
          setConfirm(null);
          onStarted?.(j.id);
        },
      },
    );

  const ask = (a: StackAction) => (actionText[a].confirm ? setConfirm(a) : start(a));
  // why an action of the block is greyed (null = possible)
  const why = (a: StackAction) =>
    !stack.managed ? 'stack non managée'
    : !host.online ? 'hôte hors ligne'
    : disabled ? 'une tâche est en cours'
    : !actions.includes(a) ? 'stack arrêtée'
    : null;

  return (
    <>
      {compact ? (
        <IconGroup
          actions={all.map((a) => {
            const w = why(a);
            const label = a === 'docker_update' && stack.updates > 0 && !service ? `${actionText[a].label} (${stack.updates} MAJ)` : actionText[a].label;
            return {
              icon: actionText[a].icon,
              title: w ? `${label} — impossible : ${w}` : label,
              disabled: !!w || run.isPending,
              danger: a === 'docker_stop',
              onClick: (e) => {
                e.preventDefault();
                ask(a);
              },
            };
          })}
        />
      ) : (
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((a) => {
          const t = actionText[a];
          return (
            <Button
              key={a}
              size="sm"
              icon={t.icon}
              variant={highlight(a) ? 'primary' : 'secondary'}
              disabled={off || run.isPending}
              onClick={(e) => {
                e.preventDefault();
                ask(a);
              }}
            >
              {t.label}
            </Button>
          );
        })}
      </div>
      )}
      {confirm && (
        <ConfirmModal
          open
          onClose={() => setConfirm(null)}
          title={`${actionText[confirm].label} ${service ? `${stack.name}/${service}` : stack.name}`}
          confirmLabel={actionText[confirm].label}
          danger
          loading={run.isPending}
          onConfirm={() => start(confirm)}
        >
          {actionText[confirm].confirm?.(what)}
          <p className="mt-2 text-xs text-muted">Hôte : {host.name}</p>
        </ConfirmModal>
      )}
    </>
  );
}

export function CheckImagesButton({ host, disabled, onStarted }: { host: Host; disabled?: boolean; onStarted?: (jobId: string) => void }) {
  const { canWrite } = useMe();
  const run = useRunJob();
  if (!canWrite) return null;
  return (
    <Button
      size="sm"
      icon={RefreshCw}
      disabled={disabled || !host.online}
      loading={run.isPending}
      title="Compare chaque image au registre (sans rien télécharger)"
      onClick={() => run.mutate({ hostId: host.id, action: 'docker_check' }, { onSuccess: (j) => onStarted?.(j.id) })}
    >
      Vérifier les images
    </Button>
  );
}

// Service chips of a stack, capped so a big stack doesn't widen its table column.
const MAX_SERVICE_TAGS = 4;

export function ServiceTags({ services, wrap = false }: { services: { name: string }[]; wrap?: boolean }) {
  const shown = services.slice(0, MAX_SERVICE_TAGS);
  const hidden = services.slice(MAX_SERVICE_TAGS);
  return (
    <div className={wrap ? 'flex max-w-full flex-wrap gap-1' : 'flex max-w-xs flex-nowrap gap-1 overflow-x-auto'}>
      {shown.map((s) => <Tag key={s.name} wrap={wrap}>{s.name}</Tag>)}
      {hidden.length > 0 && (
        <span title={hidden.map((s) => s.name).join(', ')} className="cursor-help">
          <Tag>+{hidden.length}…</Tag>
        </span>
      )}
    </div>
  );
}

// Stacks of a host, on its detail page.
export function DockerPanel({ host, running, onStarted }: { host: Host; running: boolean; onStarted: (jobId: string) => void }) {
  const { canWrite, canLogs, canSettings } = useMe();
  const navigate = useNavigate();
  const d = host.docker;
  if (!d) return null;
  // the Logs column while the collector of the journals of the containers is set up (homelab#346)
  const collecting = !!d.logs.state;
  return (
    <Panel
      title="Docker"
      icon={Container}
      bodyClassName=""
      className="@container"
      actions={
        <div className="flex items-center gap-2">
          {collecting && canLogs && (
            <Button size="sm" icon={ScrollText} title="Logs : les journaux des conteneurs de cet hôte" onClick={() => navigate(hostLogsPath(host.id, '&source=docker'))}>
              Logs
            </Button>
          )}
          <CheckImagesButton host={host} disabled={running} onStarted={onStarted} />
        </div>
      }
    >
      {d.stacks.length === 0 ? (
        <p className="p-4 text-sm text-muted">Aucune stack compose sur cet hôte.</p>
      ) : (
        <div>
          <div className="divide-y divide-line @2xl:hidden">
            {d.stacks.map((st) => (
              <article key={st.name} className="min-w-0 space-y-3 p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <Link
                    to={stackPath(host.id, st.name)}
                    title={st.name}
                    className="min-w-0 truncate font-medium text-zinc-100 hover:text-emerald-300"
                  >
                    {st.name}
                  </Link>
                  {canWrite && <StackActions host={host} stack={st} disabled={running} compact onStarted={onStarted} />}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StackStatusBadge stack={st} />
                  {st.managed && <ImageUpdateBadge update={st.update} count={st.updates} />}
                  {collecting && <StackLogsCell host={host} stack={st} />}
                </div>
                {st.problems.length > 0 && <p className="break-words text-xs text-amber-300">{st.problems.join(' · ')}</p>}
                {st.services.length > 0 && <ServiceTags services={st.services} wrap />}
              </article>
            ))}
          </div>
          <div className="hidden overflow-x-auto @2xl:block">
          <table className="w-full text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className="th pl-4">Stack</th>
                <th className="th">État</th>
                <th className="th">Images</th>
                {collecting && <th className="th">Logs</th>}
                <th className="th hidden md:table-cell">Services</th>
                {canWrite && <th className="th pr-4 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.stacks.map((st) => (
                <tr key={st.name} className="hover:bg-raised/40">
                  <td className="td pl-4">
                    <Link to={stackPath(host.id, st.name)} className="font-medium text-zinc-100 hover:text-emerald-300">
                      {st.name}
                    </Link>
                    {st.problems.length > 0 && <p className="text-xs text-amber-300">{st.problems.join(' · ')}</p>}
                  </td>
                  <td className="td"><StackStatusBadge stack={st} /></td>
                  <td className="td">{st.managed && <ImageUpdateBadge update={st.update} count={st.updates} />}</td>
                  {collecting && <td className="td"><StackLogsCell host={host} stack={st} /></td>}
                  <td className="td hidden md:table-cell">
                    <ServiceTags services={st.services} />
                  </td>
                  {canWrite && (
                    <td className="td pr-4">
                      <div className="flex justify-end"><StackActions host={host} stack={st} disabled={running} compact onStarted={onStarted} /></div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
      <p className="border-t border-line px-4 py-2 text-xs text-muted">
        Docker {d.engine} · compose {d.compose} · images vérifiées {d.updatesCheckedAt ? timeAgo(d.updatesCheckedAt) : 'jamais'}
        {d.logs.available && (
          <>
            {' · '}
            journaux des conteneurs{' '}
            {d.logs.state ? (
              <span className="font-mono">→ {d.logs.state.address}:{d.logs.state.port}</span>
            ) : d.logs.enabled ? (
              <span className="text-amber-300">collecteur absent</span>
            ) : (
              'non suivis'
            )}
            {canSettings && <> (<Link to="/roles/logs" className="text-emerald-400 hover:underline">Rôles › Logs</Link>)</>}
          </>
        )}
      </p>
    </Panel>
  );
}
