import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CircleArrowUp, Container, DatabaseBackup, PackageCheck, ShieldAlert, Wand2, Zap, type LucideIcon } from 'lucide-react';
import type { BackupGroup, Host } from '../lib/api';
import { useDockerUpdate, useRunBulk } from '../lib/queries';
import { allStacks, canSelfUpdate, hasApt } from '../lib/status';
import { Button, ConfirmModal, Panel, Tag } from './ui';

type ActionId = 'security' | 'apt' | 'docker' | 'agents' | 'setup';

interface Action {
  id: ActionId;
  icon: LucideIcon;
  title: string;
  detail: string;
  button: string;
  // red button: security comes first (not a destructive action, the confirmation stays neutral)
  urgent?: boolean;
  // hosts (or stacks) shown in the confirmation
  targets: { key: string; label: string }[];
  intro: ReactNode;
  run: (done?: () => void) => void;
  loading: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

// Actions on every host concerned, shown only when there is something to do. Grouped actions, so each
// one confirms with the list of its targets (CLAUDE.md), except when a single host is concerned.
export function DashboardActions({ hosts, groups }: { hosts: Host[]; groups: BackupGroup[] | undefined }) {
  const bulk = useRunBulk();
  const docker = useDockerUpdate();
  const [open, setOpen] = useState<ActionId | null>(null);

  const online = hosts.filter((h) => h.online);
  const security = online.filter((h) => hasApt(h) && (h.aptSummary?.security ?? 0) > 0);
  const apt = online.filter((h) => hasApt(h) && (h.aptSummary?.upgradable ?? 0) > 0);
  const stacks = allStacks(online).filter((s) => s.managed && s.updates > 0);
  const agents = online.filter((h) => h.agentOutdated && canSelfUpdate(h));
  const setup = online.filter((h) => h.capabilities.includes('setup') && (h.setup?.drift ?? 0) > 0);
  const lateBackups = (groups ?? []).filter((g) => g.state !== 'ok').length;

  const hostTargets = (list: Host[], extra?: (h: Host) => string) => list.map((h) => ({ key: h.id, label: extra ? `${h.name} · ${extra(h)}` : h.name }));
  const bulkRun = (list: Host[], action: 'apt_upgrade' | 'agent_update' | 'setup_apply', securityOnly?: boolean) => (done?: () => void) =>
    bulk.mutate({ hostIds: list.map((h) => h.id), action, securityOnly }, { onSuccess: done });
  const busy = (action: string, securityOnly?: boolean) => bulk.isPending && bulk.variables?.action === action && !!bulk.variables.securityOnly === !!securityOnly;

  const all: Action[] = [
    {
      id: 'security',
      icon: ShieldAlert,
      title: 'Correctifs de sécurité',
      detail: plural(security.length, 'hôte') + ' concerné' + (security.length > 1 ? 's' : ''),
      button: 'Appliquer',
      urgent: true,
      targets: hostTargets(security, (h) => plural(h.aptSummary!.security, 'paquet')),
      intro: <>Seuls les paquets de sécurité de chaque hôte sont mis à jour, les autres restent en attente.</>,
      run: bulkRun(security, 'apt_upgrade', true),
      loading: busy('apt_upgrade', true),
    },
    {
      id: 'apt',
      icon: PackageCheck,
      title: 'Paquets APT',
      detail: plural(apt.length, 'hôte') + ' avec des mises à jour',
      button: 'Tout mettre à jour',
      targets: hostTargets(apt, (h) => plural(h.aptSummary!.upgradable, 'paquet')),
      intro: <>Tous les paquets à mettre à jour de chaque hôte (comme <code>apt upgrade</code>, nouveaux paquets du noyau compris).</>,
      run: bulkRun(apt, 'apt_upgrade'),
      loading: busy('apt_upgrade'),
    },
    {
      id: 'docker',
      icon: Container,
      title: 'Conteneurs Docker',
      detail: plural(stacks.length, 'stack') + ' avec une image plus récente',
      button: 'Tout mettre à jour',
      targets: stacks.map((s) => ({ key: `${s.host.id}/${s.name}`, label: `${s.name} · ${s.host.name}` })),
      intro: <>Chaque stack télécharge ses nouvelles images puis recrée ses conteneurs (courte coupure du service).</>,
      run: (done) => docker.mutate(stacks.map((s) => ({ hostId: s.host.id, stack: s.name })), { onSuccess: done }),
      loading: docker.isPending,
    },
    {
      id: 'agents',
      icon: CircleArrowUp,
      title: 'Agents',
      detail: plural(agents.length, 'agent') + ' à mettre à jour',
      button: 'Mettre à jour',
      targets: hostTargets(agents),
      intro: <>L'agent télécharge la nouvelle version depuis le hub, vérifie son empreinte et sa signature puis redémarre (quelques secondes).</>,
      run: bulkRun(agents, 'agent_update'),
      loading: busy('agent_update'),
    },
    {
      id: 'setup',
      icon: Wand2,
      title: 'Standardisation',
      detail: plural(setup.length, 'hôte') + ' désynchronisé' + (setup.length > 1 ? 's' : ''),
      button: 'Réactualiser',
      targets: hostTargets(setup, (h) => plural(h.setup!.drift, 'option')),
      intro: <>La standardisation est appliquée de nouveau, avec les valeurs propres de chaque hôte.</>,
      run: bulkRun(setup, 'setup_apply'),
      loading: busy('setup_apply'),
    },
  ];
  const actions = all.filter((a) => a.targets.length > 0);

  const current = actions.find((a) => a.id === open);

  return (
    <Panel title="Actions sur tous les hôtes" icon={Zap} bodyClassName="px-4 py-1">
      {actions.length === 0 && lateBackups === 0 && <p className="py-4 text-sm text-muted">Rien à lancer : tout est à jour. 🎉</p>}
      {actions.map((a) => (
        <div key={a.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line py-2.5 first:border-t-0">
          <span className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <a.icon className="h-4 w-4 shrink-0 text-muted" />
            {a.title}
          </span>
          <Button
            size="sm"
            variant={a.urgent ? 'danger' : 'primary'}
            loading={a.loading}
            // a single target: a unit action, started right away
            onClick={() => (a.targets.length === 1 ? a.run() : setOpen(a.id))}
          >
            {a.button}
          </Button>
          <span className="pl-6 text-xs text-muted">{a.detail}</span>
        </div>
      ))}
      {lateBackups > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line py-2.5 first:border-t-0">
          <span className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <DatabaseBackup className="h-4 w-4 shrink-0 text-muted" />
            Sauvegardes
          </span>
          <Link to="/backups?f=late" className="inline-flex h-7 items-center rounded-md border border-line bg-raised px-2.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800">
            Ouvrir
          </Link>
          <span className="pl-6 text-xs text-muted">{plural(lateBackups, 'sauvegarde')} en échec ou en retard</span>
        </div>
      )}
      {current && (
        <ConfirmModal
          open
          onClose={() => setOpen(null)}
          title={current.title}
          confirmLabel={`${current.button} (${current.targets.length})`}
          loading={current.loading}
          onConfirm={() => current.run(() => setOpen(null))}
        >
          <p className="mb-3">{current.intro}</p>
          <div className="flex flex-wrap gap-1.5">{current.targets.map((t) => <Tag wrap key={t.key}>{t.label}</Tag>)}</div>
          <p className="mt-3 text-xs text-muted">Le résultat se suit hôte par hôte dans l'activité (une tâche par hôte{current.id === 'docker' ? ' et par stack' : ''}).</p>
        </ConfirmModal>
      )}
    </Panel>
  );
}
