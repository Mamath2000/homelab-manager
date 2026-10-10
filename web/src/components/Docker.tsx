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
      <span title="Gérée en dehors de Homelab Manager : ni état, ni mise à jour, ni action">
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

// Image state of a stack; nothing for an unmanaged one.
export function StackImagesBadge({ stack }: { stack: Pick<DockerStack, 'managed' | 'update' | 'updates'> }) {
  return stack.managed ? <ImageUpdateBadge update={stack.update} count={stack.updates} /> : <span className="text-xs text-muted">—</span>;
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

const actionText: Record<StackAction, { label: string; icon: typeof Play; confirm: (what: string) => string; danger?: boolean }> = {
  docker_up: {
    label: 'Démarrer',
    icon: Play,
    confirm: (w) => `docker compose up -d sur ${w} : crée ou démarre les conteneurs, et recrée ceux dont la configuration a changé sur l'hôte.`,
  },
  docker_stop: { label: 'Arrêter', icon: Square, danger: true, confirm: (w) => `docker compose stop sur ${w} : les conteneurs sont arrêtés, pas supprimés.` },
  docker_restart: { label: 'Redémarrer', icon: RotateCw, confirm: (w) => `docker compose restart sur ${w}.` },
  docker_update: {
    label: 'Mettre à jour',
    icon: ArrowUpCircle,
    confirm: (w) =>
      `docker compose pull puis up -d sur ${w} : les nouvelles images sont téléchargées et les conteneurs concernés recréés. Les anciennes images devenues inutiles sont supprimées (docker image prune).`,
  },
};

// Buttons for a stack, or one of its services, with a confirmation.
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
              disabled={off}
              onClick={(e) => {
                e.preventDefault();
                setConfirm(a);
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
          danger={actionText[confirm].danger}
          loading={run.isPending}
          onConfirm={() =>
            run.mutate(
              { hostId: host.id, action: confirm, target: { stack: stack.name, service } },
              {
                onSuccess: (j) => {
                  setConfirm(null);
                  onStarted?.(j.id);
                },
              },
            )
          }
        >
          {actionText[confirm].confirm(what)}
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
                <td className="td"><StackImagesBadge stack={st} /></td>
                <td className="td hidden md:table-cell">
                  <div className="flex flex-wrap gap-1">{st.services.map((s) => <Tag key={s.name}>{s.name}</Tag>)}</div>
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
