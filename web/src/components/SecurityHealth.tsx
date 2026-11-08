import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Box, CheckCircle2, CircleHelp, Database, Globe, RefreshCw, Radio, Shield, Terminal, TriangleAlert, XCircle, type LucideIcon } from 'lucide-react';
import { api, type SecurityCheck, type SecurityStatus } from '../lib/api';
import { Badge, Button, Panel, Spinner, VerticalTabs } from './ui';
import { toneText } from '../lib/status';

const ICON = { ok: CheckCircle2, warn: TriangleAlert, bad: XCircle, unknown: CircleHelp } satisfies Record<SecurityStatus, LucideIcon>;
const LABEL: Record<SecurityStatus, string> = { ok: 'OK', warn: 'À améliorer', bad: 'Risque', unknown: 'Non vérifiable' };
// same look as the options of the standardisation: a bordered block, tinted by its state
const BLOCK: Record<SecurityStatus, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/[0.03]',
  warn: 'border-amber-500/30 bg-amber-500/[0.04]',
  bad: 'border-red-500/40 bg-red-500/[0.05]',
  unknown: 'border-line bg-raised/20',
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

function Block({ check }: { check: SecurityCheck }) {
  return (
    <div className={`rounded-md border p-4 ${BLOCK[check.status]}`}>
      <div className="flex items-start gap-3">
        <StatusIcon status={check.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-zinc-100">{check.label}</span>
            <Badge tone={check.status}>{LABEL[check.status]}</Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{check.detail}</p>
          {check.items && (
            <ul className="mt-3 space-y-1.5 border-t border-line/60 pt-3">
              {check.items.map((item) => (
                <li key={item.name} className="flex items-start gap-2 text-xs">
                  <StatusIcon status={item.status} className="mt-px !h-3.5 !w-3.5" />
                  <span className="min-w-0"><span className="font-medium text-zinc-200">{item.name}</span> <span className="text-muted">· {item.detail}</span></span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// Settings > Sécurité: posture of the installation as the hub sees it (homelab#310). Admins only.
export function SecurityHealthPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['settings', 'security'], queryFn: api.securityHealth });
  const [picked, setPicked] = useState<string | null>(null);
  if (isLoading) return <div className="flex justify-center p-10"><Spinner /></div>;
  if (error || !data) return <Panel title="Santé sécurité" icon={Shield}><p className="p-4 text-sm text-red-300">Impossible de lire la posture de sécurité.</p></Panel>;

  const { summary, groups } = data;
  const issues = (g: (typeof groups)[number]) => g.checks.filter((c) => c.status === 'bad' || c.status === 'warn').length;
  // opens on the first group that needs attention
  const current = groups.find((g) => g.id === picked) ?? groups.find((g) => issues(g) > 0) ?? groups[0];

  return (
    <Panel
      title="Santé sécurité"
      icon={Shield}
      bodyClassName=""
      actions={
        <div className="flex items-center gap-2">
          {summary.bad > 0 && <Badge tone="bad">{summary.bad} risque{summary.bad > 1 ? 's' : ''}</Badge>}
          {summary.warn > 0 && <Badge tone="warn">{summary.warn} à améliorer</Badge>}
          <Badge tone="ok">{summary.ok} OK</Badge>
          {summary.unknown > 0 && <Badge tone="unknown">{summary.unknown} non vérifiable{summary.unknown > 1 ? 's' : ''}</Badge>}
          <Button size="sm" variant="ghost" loading={isFetching} onClick={() => void refetch()} title="Revérifier" aria-label="Revérifier"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      }
    >
      <VerticalTabs
        tabs={groups.map((g) => ({ id: g.id, label: g.title, icon: GROUP_ICON[g.id] ?? Shield, count: issues(g) || undefined }))}
        value={current.id}
        onChange={setPicked}
        bodyClassName="space-y-3 p-4 text-sm"
      >
        <div className="flex items-center gap-2">
          <StatusIcon status={worst(current.checks.map((c) => c.status))} />
          <h3 className="text-base font-medium text-zinc-100">{current.title}</h3>
        </div>
        <p className="text-xs text-muted">{GROUP_HINT[current.id]}</p>
        {current.checks.map((c) => <Block key={c.id} check={c} />)}
        <p className="pt-1 text-xs text-muted">Vue depuis le hub. Les points « non vérifiables » sont ceux qu’il ne peut pas voir (ACL du broker, par exemple). La double authentification des admins n’est pas contrôlée tant qu’elle n’existe pas.</p>
      </VerticalTabs>
    </Panel>
  );
}
