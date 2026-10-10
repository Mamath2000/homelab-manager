import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowUpCircle, Container, Play, RefreshCw, RotateCw, Square } from 'lucide-react';
import type { DockerStack, Host, ImageUpdate, StackAction } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { useRunJob } from '../lib/queries';
import { imageUpdateMeta, stackMeta, stackPath } from '../lib/status';
import { Badge, Button, ConfirmModal, Panel, Tag } from './ui';

export function StackStatusBadge({ stack }: { stack: Pick<DockerStack, 'managed' | 'status' | 'running' | 'total'> }) {
  if (!stack.managed) {
    return (
      <span title="Gérée en dehors de Homelab Manager : mises à jour d'image affichées pour information, ni état ni action">
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
      <Badge tone={m.tone}>
        {update === 'available' && count ? `${count} MAJ` : m.label}
      </Badge>
    </span>
  );
}

// `confirm` = the action asks for a confirmation before starting (stop only).
const actionText: Record<StackAction, { label: string; icon: typeof Play; confirm?: (what: string) => string }> = {
  docker_up: { label: 'Démarrer', icon: Play },
  docker_stop: { label: 'Arrêter', icon: Square, confirm: (w) => `docker compose stop sur ${w} : les conteneurs sont arrêtés, pas supprimés.` },
  docker_restart: { label: 'Redémarrer', icon: RotateCw },
  docker_update: { label: 'Mettre à jour', icon: ArrowUpCircle },
};

// Buttons for a stack, or one of its services; only stopping asks for a confirmation.
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
  // unmanaged: read-only, no action at all
  if (!canWrite || !stack.managed) return null;
  const what = service ? `le service ${service} de ${stack.name}` : `la stack ${stack.name}`;
  const off = disabled || !host.online;
  const actions: StackAction[] = stack.status === 'down' ? ['docker_up'] : ['docker_up', 'docker_restart', 'docker_stop', 'docker_update'];
  const highlight = (a: StackAction) => a === 'docker_update' && stack.updates > 0 && !service;
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

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((a) => {
          const t = actionText[a];
          return (
            <Button
              key={a}
              size="sm"
              icon={t.icon}
              variant={highlight(a) ? 'primary' : compact ? 'ghost' : 'secondary'}
              title={compact ? t.label : undefined}
              disabled={off || run.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (t.confirm) setConfirm(a);
                else start(a);
              }}
            >
              {!compact && t.label}
            </Button>
          );
        })}
      </div>
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

export function ServiceTags({ services }: { services: { name: string }[] }) {
  const shown = services.slice(0, MAX_SERVICE_TAGS);
  const hidden = services.slice(MAX_SERVICE_TAGS);
  return (
    <div className="flex max-w-xs flex-wrap gap-1">
      {shown.map((s) => <Tag key={s.name}>{s.name}</Tag>)}
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
  const d = host.docker;
  if (!d) return null;
  return (
    <Panel
      title="Docker"
      icon={Container}
      bodyClassName=""
      actions={<CheckImagesButton host={host} disabled={running} onStarted={onStarted} />}
    >
      {d.stacks.length === 0 ? (
        <p className="p-4 text-sm text-muted">Aucune stack compose sur cet hôte.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className="th">Stack</th>
              <th className="th">État</th>
              <th className="th">Images</th>
              <th className="th hidden md:table-cell">Services</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {d.stacks.map((st) => (
              <tr key={st.name} className="hover:bg-raised/40">
                <td className="td">
                  <Link to={stackPath(host.id, st.name)} className="font-medium text-zinc-100 hover:text-emerald-300">
                    {st.name}
                  </Link>
                  {st.problems.length > 0 && <p className="text-xs text-amber-300">{st.problems.join(' · ')}</p>}
                </td>
                <td className="td"><StackStatusBadge stack={st} /></td>
                <td className="td"><ImageUpdateBadge update={st.update} count={st.updates} /></td>
                <td className="td hidden md:table-cell">
                  <ServiceTags services={st.services} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="border-t border-line px-4 py-2 text-xs text-muted">
        Docker {d.engine} · compose {d.compose} · images vérifiées {d.updatesCheckedAt ? timeAgo(d.updatesCheckedAt) : 'jamais'}
      </p>
    </Panel>
  );
}
