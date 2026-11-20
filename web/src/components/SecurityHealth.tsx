import { useQuery } from '@tanstack/react-query';
import { Box, CheckCircle2, CircleHelp, Database, Globe, RefreshCw, Radio, Shield, Terminal, TriangleAlert, XCircle, type LucideIcon } from 'lucide-react';
import { api, type SecurityCheck, type SecurityStatus } from '../lib/api';
import { Badge, Button, Panel, Spinner } from './ui';
import { toneText } from '../lib/status';

const ICON = { ok: CheckCircle2, warn: TriangleAlert, bad: XCircle, unknown: CircleHelp } satisfies Record<SecurityStatus, LucideIcon>;
const LABEL: Record<SecurityStatus, string> = { ok: 'OK', warn: 'À améliorer', bad: 'Risque', unknown: 'Non vérifiable' };
// the edge of a card, by the worst state of its checks
const EDGE: Record<SecurityStatus, string> = {
  ok: 'border-line border-t-emerald-500/60',
  warn: 'border-amber-500/30 border-t-amber-500',
  bad: 'border-red-500/40 border-t-red-500',
  unknown: 'border-line border-t-zinc-500',
};
const GROUP_ICON: Record<string, LucideIcon> = { access: Globe, data: Database, agents: Terminal, mqtt: Radio, container: Box };
const GROUP_HINT: Record<string, string> = {
  access: 'Comment cette page est servie et protégée, vu depuis le navigateur qui la consulte.',
  data: 'Protection de MongoDB et des secrets qui y sont stockés.',
  agents: 'Signature des binaires distribués et protections présentes sur chaque agent enrôlé.',
  mqtt: 'Brokers déclarés dans les rôles, dont celui du pont Home Assistant.',
  container: 'Durcissement du conteneur du hub, lu depuis le processus (voir compose.hardened.yml).',
};

const worst = (list: SecurityStatus[]): SecurityStatus => (['bad', 'warn', 'unknown', 'ok'] as const).find((s) => list.includes(s)) ?? 'ok';

function StatusIcon({ status, className = '' }: { status: SecurityStatus; className?: string }) {
  const Icon = ICON[status];
  return <Icon className={`h-4 w-4 shrink-0 ${toneText[status]} ${className}`} aria-label={LABEL[status]} />;
}

// one check of a group: its state, what it looks at, and its items (one per broker, per agent…) below
function CheckRow({ check }: { check: SecurityCheck }) {
  return (
    <li className="flex items-start gap-2.5 border-t border-line/60 py-2.5 first:border-t-0">
      <StatusIcon status={check.status} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="font-medium text-zinc-100">{check.label}</span>
          {check.status !== 'ok' && <Badge tone={check.status}>{LABEL[check.status]}</Badge>}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{check.detail}</p>
        {check.items && (
          <ul className="mt-2 space-y-1">
            {check.items.map((item) => (
              <li key={item.name} className="flex items-start gap-2 text-xs">
                <StatusIcon status={item.status} className="mt-px !h-3.5 !w-3.5" />
                <span className="min-w-0"><span className="font-medium text-zinc-200">{item.name}</span> <span className="text-muted">· {item.detail}</span></span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

// Settings > Sécurité: posture of the installation as the hub sees it (homelab#310). Admins only.
export function SecurityHealthPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['settings', 'security'], queryFn: api.securityHealth });
  if (isLoading) return <div className="flex justify-center p-10"><Spinner /></div>;
  if (error || !data) return <Panel title="Santé sécurité" icon={Shield}><p className="p-4 text-sm text-red-300">Impossible de lire la posture de sécurité.</p></Panel>;

  const { summary, groups } = data;
  const issues = (g: (typeof groups)[number]) => g.checks.filter((c) => c.status === 'bad' || c.status === 'warn').length;

  return (
    <Panel
      title="Santé sécurité"
      icon={Shield}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {summary.bad > 0 && <Badge tone="bad">{summary.bad} risque{summary.bad > 1 ? 's' : ''}</Badge>}
          {summary.warn > 0 && <Badge tone="warn">{summary.warn} à améliorer</Badge>}
          <Badge tone="ok">{summary.ok} OK</Badge>
          {summary.unknown > 0 && <Badge tone="unknown">{summary.unknown} non vérifiable{summary.unknown > 1 ? 's' : ''}</Badge>}
          <Button size="sm" variant="ghost" loading={isFetching} onClick={() => void refetch()} title="Revérifier" aria-label="Revérifier"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      }
    >
      {/* every group at once, one card each: the ones that need attention stand out by their edge and badge */}
      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => {
          const Icon = GROUP_ICON[g.id] ?? Shield;
          const state = worst(g.checks.map((c) => c.status));
          const n = issues(g);
          return (
            <section key={g.id} className={`min-w-0 rounded-lg border border-t-[3px] bg-raised/30 px-4 py-3 text-sm ${EDGE[state]}`}>
              <header className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <h3 className="min-w-0 flex-1 truncate font-medium text-zinc-100">{g.title}</h3>
                <Badge tone={state}>{n ? `${n} à revoir` : LABEL[state]}</Badge>
              </header>
              <p className="mt-1 text-xs text-muted">{GROUP_HINT[g.id]}</p>
              <ul className="mt-2">{g.checks.map((c) => <CheckRow key={c.id} check={c} />)}</ul>
            </section>
          );
        })}
      </div>
      <p className="pt-3 text-xs text-muted">Vue depuis le hub. Les points « non vérifiables » sont ceux qu’il ne peut pas voir (ACL du broker, par exemple).</p>
    </Panel>
  );
}
