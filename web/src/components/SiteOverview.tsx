import { useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { MapPin } from 'lucide-react';
import type { BackupGroup, Host } from '../lib/api';
import { hostBackups } from '../lib/backups';
import { timeAgo } from '../lib/format';
import {
  aptTile,
  aptTileMeta,
  backupTile,
  backupTileMeta,
  count,
  dockerTile,
  dockerTileMeta,
  oldestBackup,
  siteKindMeta,
  siteTone,
  type AptTile,
  type BackupTile,
  type DockerTile,
  type Site,
} from '../lib/sites';
import { toneStroke } from '../lib/status';
import { Badge, Panel, Segmented } from './ui';

type Mode = 'both' | 'apt' | 'backups' | 'docker';
const MODE_KEY = 'dashboard.tiles';

function savedMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'apt' || v === 'backups' || v === 'docker' ? v : 'both';
  } catch {
    return 'both';
  }
}

const dayMs = 24 * 3600 * 1000;
const ageText = (ms: number | null) => (ms === null ? '—' : ms < dayMs ? "moins d'un jour" : `${Math.floor(ms / dayMs)} j`);

// One square per host, linked to its page: updates, backups and Docker in combined mode.
function Tile({ host, groups, mode, small, backups }: { host: Host; groups: BackupGroup[] | undefined; mode: Mode; small?: boolean; backups: boolean }) {
  const apt = aptTile(host);
  const bak = backupTile(groups, host.id);
  const dck = dockerTile(host);
  const last = hostBackups(groups, host.id)?.last;
  const title = [
    host.name,
    `mises à jour : ${aptTileMeta[apt].label}`,
    (mode === 'both' || mode === 'backups') && backups && `sauvegarde : ${backupTileMeta[bak].label}${last ? ` (${timeAgo(last)})` : ''}`,
    `Docker : ${host.online ? (host.docker ? dockerTileMeta[dck].label : 'sans Docker') : 'hors ligne'}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Link
      to={`/hosts/${host.id}`}
      title={title}
      aria-label={title}
      className={clsx('flex flex-col gap-px transition hover:brightness-125 focus-visible:outline-2 focus-visible:outline-emerald-400', small ? 'h-[26px] w-[26px]' : 'h-[30px] w-[30px]')}
    >
      {(mode === 'both' || mode === 'apt') && <span className={clsx('flex-1 rounded-[3px]', aptTileMeta[apt].cls)} />}
      {(mode === 'both' || mode === 'backups') && backups && <span className={clsx('flex-1 rounded-[3px]', backupTileMeta[bak].cls)} />}
      {(mode === 'both' || mode === 'docker') && <span className={clsx('flex-1 rounded-[3px]', dockerTileMeta[dck].cls)} />}
    </Link>
  );
}

// Stacked bar of a site: one segment per state, worst first.
function Meter<T extends string>({ label, summary, parts }: { label: string; summary: React.ReactNode; parts: { n: number; color: string; key: T }[] }) {
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  return (
    <div className="min-w-0">
      <div className="mb-1 flex flex-wrap justify-between gap-x-2 text-xs text-muted">
        <span>{label}</span>
        <span className="text-zinc-300">{summary}</span>
      </div>
      <div className="flex h-2 gap-[2px] overflow-hidden rounded bg-line">
        {parts.filter((p) => p.n > 0).map((p) => <span key={p.key} style={{ width: `${(p.n / total) * 100}%`, background: p.color }} />)}
      </div>
    </div>
  );
}

const aptColor: Partial<Record<AptTile, string>> = { security: '#ef4444', updates: '#f59e0b', reboot: '#0ea5e9', offline: '#52525b', unknown: '#8b5cf6', uptodate: '#10b981' };
const bakColor: Record<BackupTile, string> = { bad: '#ef4444', warn: '#f59e0b', none: '#3f3f46', ok: '#10b981' };
const dckColor: Record<DockerTile, string> = { problem: '#ef4444', updates: '#f59e0b', none: '#3f3f46', ok: '#10b981' };

// stacked: the two meters one under the other (narrow column)
function Meters({ site, groups, backups, stacked }: { site: Site; groups: BackupGroup[] | undefined; backups: boolean; stacked?: boolean }) {
  const apt = site.hosts.map(aptTile);
  const bak = site.hosts.map((h) => backupTile(groups, h.id));
  const n = (v: AptTile) => count(apt, v);
  const b = (v: BackupTile) => count(bak, v);
  const aptSummary = [
    n('security') > 0 && <span key="s" className="text-red-400">{n('security')} sécurité</span>,
    n('updates') + n('security') > 0 && `${n('updates') + n('security')} avec MAJ`,
    n('reboot') > 0 && `${n('reboot')} reboot`,
    n('offline') > 0 && `${n('offline')} hors ligne`,
  ].filter(Boolean);
  const bakSummary = [
    b('bad') > 0 && <span key="b" className="text-red-400">{b('bad')} en échec</span>,
    b('warn') > 0 && `${b('warn')} en retard`,
    `${b('ok')} à jour`,
    b('none') > 0 && `${b('none')} non suivie${b('none') > 1 ? 's' : ''}`,
  ].filter(Boolean);
  const dck = site.hosts.map(dockerTile);
  const d = (v: DockerTile) => count(dck, v);
  const dckSummary = [
    d('problem') > 0 && <span key="d" className="text-red-400">{d('problem')} en problème</span>,
    d('updates') > 0 && `${d('updates')} avec MAJ`,
    `${d('ok')} à jour`,
    d('none') > 0 && `${d('none')} non suivi${d('none') > 1 ? 's' : ''}`,
  ].filter(Boolean);
  const join = (l: React.ReactNode[]) => (l.length ? l.flatMap((x, i) => (i ? [' · ', x] : [x])) : 'tout est à jour');
  return (
    <div className={clsx('grid gap-x-5 gap-y-2', !stacked && (backups ? 'sm:grid-cols-3' : 'sm:grid-cols-2'))}>
      <Meter label="Mises à jour" summary={join(aptSummary)} parts={(Object.keys(aptColor) as AptTile[]).map((k) => ({ key: k, n: n(k), color: aptColor[k]! }))} />
      {backups && (
        <div>
          <Meter label="Sauvegardes" summary={join(bakSummary)} parts={(Object.keys(bakColor) as BackupTile[]).map((k) => ({ key: k, n: b(k), color: bakColor[k] }))} />
          <p className="mt-1 text-[11px] text-muted">plus ancienne : {ageText(oldestBackup(site.hosts, groups))}</p>
        </div>
      )}
      <Meter label="Docker" summary={join(dckSummary)} parts={(Object.keys(dckColor) as DockerTile[]).map((k) => ({ key: k, n: d(k), color: dckColor[k] }))} />
    </div>
  );
}

function SiteHeader({ site, groups }: { site: Site; groups: BackupGroup[] | undefined }) {
  return (
    <header className="flex flex-wrap items-center gap-2.5">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: toneStroke[siteTone(site.hosts, groups)] }} />
      <b className="text-[15px] font-medium text-zinc-100">{site.name}</b>
      {site.kind && <Badge tone="neutral">{siteKindMeta[site.kind].label}</Badge>}
      <span className="text-xs text-muted">{site.hosts.length} hôte{site.hosts.length > 1 ? 's' : ''}</span>
    </header>
  );
}

function SiteCard({ site, groups, mode, backups, small }: { site: Site; groups: BackupGroup[] | undefined; mode: Mode; backups: boolean; small?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SiteHeader site={site} groups={groups} />
      <div className="flex flex-wrap gap-x-1.5 gap-y-2">
        {site.hosts.map((h) => <Tile key={h.id} host={h} groups={groups} mode={mode} small={small} backups={backups} />)}
      </div>
      <Meters site={site} groups={groups} backups={backups} stacked={small} />
    </div>
  );
}

// External sites of a single host: one line each instead of a card.
function ExternalSites({ sites, groups, backups }: { sites: Site[]; groups: BackupGroup[] | undefined; backups: boolean }) {
  return (
    <div>
      <header className="mb-1 flex items-center gap-2.5">
        <b className="text-[15px] font-medium text-zinc-100">Sites externes</b>
        <Badge tone="neutral">supervisés</Badge>
      </header>
      {sites.map((s) => {
        const h = s.hosts[0];
        const apt = aptTile(h);
        const bak = backupTile(groups, h.id);
        const dck = dockerTile(h);
        const dockerLabel = !h.online
          ? 'Docker · hors ligne'
          : h.docker
            ? `Docker · ${dck === 'updates' ? 'MAJ' : dck === 'problem' ? 'problème' : dockerTileMeta[dck].label}`
            : 'sans Docker';
        return (
          <Link
            key={s.name}
            to={`/hosts/${h.id}`}
            className={clsx('grid items-center gap-2.5 border-t border-line py-2 text-sm first-of-type:border-t-0 hover:bg-raised/50', backups ? 'grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]' : 'grid-cols-[auto_minmax(0,1fr)_auto_auto]')}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: toneStroke[siteTone(s.hosts, groups)] }} />
            <span className="truncate">
              <span className="font-medium text-zinc-200">{s.name}</span> <span className="text-muted">{h.name}</span>
            </span>
            <Badge tone={aptTileMeta[apt].tone}>{aptTileMeta[apt].label}</Badge>
            {backups && <Badge tone={backupTileMeta[bak].tone}>sauv. {backupTileMeta[bak].label}</Badge>}
            <Badge tone={h.docker && h.online ? dockerTileMeta[dck].tone : 'neutral'}>{dockerLabel}</Badge>
          </Link>
        );
      })}
    </div>
  );
}

function Legend({ mode, backups }: { mode: Mode; backups: boolean }) {
  const aptItems: AptTile[] = ['uptodate', 'updates', 'security', 'reboot', 'offline'];
  const bakItems: BackupTile[] = ['ok', 'warn', 'bad', 'none'];
  const dckItems: DockerTile[] = ['ok', 'updates', 'problem', 'none'];
  const items =
    mode === 'docker'
      ? dckItems.map((k) => ({ cls: dockerTileMeta[k].cls, label: dockerTileMeta[k].label }))
      : mode === 'apt'
      ? aptItems.map((k) => ({ cls: aptTileMeta[k].cls, label: aptTileMeta[k].label }))
      : mode === 'backups'
        ? bakItems.map((k) => ({ cls: backupTileMeta[k].cls, label: backupTileMeta[k].label }))
        : [
            { cls: 'bg-emerald-500', label: 'OK' },
            { cls: 'bg-amber-500', label: 'mises à jour / en retard' },
            { cls: 'bg-red-500', label: 'sécurité / échec / problème Docker' },
            { cls: 'bg-sky-500', label: 'reboot' },
            { cls: 'bg-zinc-600', label: 'hors ligne / Docker non suivi' },
            { cls: backupTileMeta.none.cls, label: 'non suivie' },
          ];
  return (
    <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-muted">
      {mode === 'both' && <span>{backups ? 'haut : mises à jour · milieu : sauvegarde · bas : Docker' : 'haut : mises à jour · bas : Docker'}</span>}
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <i className={clsx('block h-2.5 w-2.5 rounded-[2px]', i.cls)} />
          {i.label}
        </span>
      ))}
    </span>
  );
}

// Sites of the dashboard: the main ones in large, then on one row the small ones and the external
// sites of a single host, grouped in one card.
export function SiteOverview({ sites, groups, backups }: { sites: Site[]; groups: BackupGroup[] | undefined; backups: boolean }) {
  const [chosen, setChosen] = useState<Mode>(savedMode);
  const mode = chosen === 'backups' && !backups ? 'apt' : chosen;
  const pick = (m: Mode) => {
    setChosen(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // private window: the choice is not kept
    }
  };
  const external = sites.filter((s) => s.kind === 'external' && s.hosts.length === 1);
  const rest = sites.filter((s) => !external.includes(s));
  // the biggest sites take the whole width, the small ones share a row
  const large = rest.filter((s) => s.kind === 'main' || s.hosts.length > 8);
  const small = rest.filter((s) => !large.includes(s));

  return (
    <Panel
      title="Sites"
      icon={MapPin}
      actions={
        sites.length > 0 && (
          <Segmented
            label="Couleur des carrés"
            value={mode}
            onChange={pick}
            options={[
              { id: 'both' as const, label: backups ? 'Les trois' : 'MAJ + Docker' },
              ...(backups ? [
                { id: 'apt' as const, label: 'Mises à jour' },
                { id: 'backups' as const, label: 'Sauvegardes' },
              ] : [{ id: 'apt' as const, label: 'Mises à jour' }]),
              { id: 'docker' as const, label: 'Docker' },
            ]}
          />
        )
      }
    >
      <div className="mb-4">
        <Legend mode={mode} backups={backups} />
      </div>
      <div className="flex flex-col gap-5">
        {large.map((s) => <SiteCard key={s.name} site={s} groups={groups} mode={mode} backups={backups} />)}
        {/* the small sites and the external ones share a row, one column each */}
        {(small.length > 0 || external.length > 0) && (
          <div className="grid gap-x-6 gap-y-5 border-t border-line pt-4 first:border-t-0 first:pt-0 md:grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
            {small.map((s) => <SiteCard key={s.name} site={s} groups={groups} mode={mode} backups={backups} small />)}
            {external.length > 0 && <ExternalSites sites={external} groups={groups} backups={backups} />}
          </div>
        )}
      </div>
    </Panel>
  );
}
