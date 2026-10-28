import type { ReactNode } from 'react';
import type { HealthCeph, HealthRaid, HealthRaidArray, HealthUnraid, HealthUnraidDisk } from '../lib/api';
import { formatBytes } from '../lib/backups';
import { dateTime } from '../lib/format';
import type { Tone } from '../lib/status';
import { Badge } from './ui';

const SYNC_LABELS: Record<string, string> = { check: 'Contrôle', repair: 'Réparation', resync: 'Resynchro', recover: 'Reconstruction', reshape: 'Remodelage' };

function arrayStatus(a: HealthRaidArray): { tone: Tone; label: string } {
  if (a.degraded > 0) return { tone: 'bad', label: 'Dégradé' };
  if (['inactive', 'readonly', 'broken', 'suspended', 'clear'].includes(a.state)) return { tone: 'bad', label: a.state };
  if (a.state === 'read-auto') return { tone: 'warn', label: 'read-auto' };
  return { tone: 'ok', label: 'Sain' };
}

// `actions` receives the prefix of the alert keys of a card (raid:md0, raid:unraid, raid:ceph), e.g. for its accept button.
type Actions = (prefix: string) => ReactNode;

function Card({ title, meta, badges, actions, children }: { title: string; meta?: ReactNode; badges?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-raised/20 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono font-medium text-zinc-100">{title}</span>
        {meta && <span className="text-muted">{meta}</span>}
        {badges}
        {actions && <span className="ml-auto">{actions}</span>}
      </div>
      {children}
    </div>
  );
}

function Progress({ percent }: { percent?: number }) {
  if (percent === undefined) return null;
  return <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/30"><div className="h-full bg-sky-400" style={{ width: `${percent}%` }} /></div>;
}

function Chip({ tone, title, children }: { tone: 'ok' | 'warn' | 'bad'; title?: string; children: ReactNode }) {
  const ring = { ok: 'text-zinc-300 ring-line', warn: 'text-amber-300 ring-amber-400/40', bad: 'text-red-300 ring-red-400/40' }[tone];
  return <span title={title} className={`rounded-sm px-1.5 py-0.5 font-mono ring-1 ring-inset ${ring}`}>{children}</span>;
}

function MdArray({ a, actions }: { a: HealthRaidArray; actions?: Actions }) {
  const status = arrayStatus(a);
  const sync = SYNC_LABELS[a.syncAction];
  return (
    <Card title={a.name} meta={`${a.level} · ${a.raidDisks - a.degraded}/${a.raidDisks} disques`} actions={actions?.(`raid:${a.name}`)}
      badges={<>
        <Badge tone={status.tone}>{status.label}</Badge>
        {sync && <Badge tone={a.syncAction === 'check' || a.syncAction === 'repair' ? 'info' : 'warn'}>{sync}{a.syncPercent !== undefined && ` ${a.syncPercent.toFixed(1)} %`}</Badge>}
        {a.mismatchCount > 0 && <span className="text-amber-300">{a.mismatchCount} incohérences</span>}
      </>}>
      <Progress percent={a.syncPercent} />
      <div className="mt-2 flex flex-wrap gap-1">
        {a.members.map((m) => {
          const faulty = m.state.split(',').includes('faulty');
          return (
            <Chip key={m.device} tone={faulty ? 'bad' : m.errors > 0 ? 'warn' : 'ok'} title={`${m.state}${m.slot !== undefined ? ` · slot ${m.slot}` : ''} · ${m.errors} erreur(s) de lecture corrigée(s)`}>
              {m.device}{!m.state.includes('in_sync') && ` · ${m.state}`}{m.errors > 0 && ` · ${m.errors} err.`}
            </Chip>
          );
        })}
      </div>
    </Card>
  );
}

function UnraidDisks({ disks }: { disks: HealthUnraidDisk[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {disks.map((d) => {
        const errors = d.errors + (d.fsErrors ?? 0);
        return (
          <Chip key={d.name} tone={d.status !== 'DISK_OK' ? 'bad' : errors > 0 ? 'warn' : 'ok'}
            title={`${d.status}${d.device ? ` · ${d.device}` : ''} · ${d.errors} erreur(s) d'entrée-sortie${d.fsErrors !== undefined ? ` · ${d.fsErrors} erreur(s) btrfs` : ''}`}>
            {d.name}{d.status !== 'DISK_OK' && ` · ${d.status.replace('DISK_', '')}`}{errors > 0 && ` · ${errors} err.`}
          </Chip>
        );
      })}
    </div>
  );
}

function UnraidArray({ u, actions }: { u: HealthUnraid; actions?: Actions }) {
  const bad = u.state !== 'STARTED' || u.disks.some((d) => d.status !== 'DISK_OK') || u.pools.some((p) => p.devices < p.devicesExpected || (p.health && p.health !== 'ONLINE'));
  const rebuild = u.syncAction?.startsWith('recon');
  const c = u.lastCheck;
  return (
    <Card title="Unraid" meta={`array · ${u.disks.length} disques${u.pools.length ? ` · ${u.pools.length} pool(s)` : ''}`} actions={actions?.('raid:unraid')}
      badges={<>
        <Badge tone={bad ? 'bad' : 'ok'}>{u.state !== 'STARTED' ? u.state || 'inconnu' : bad ? 'Dégradé' : 'Sain'}</Badge>
        {u.syncAction && <Badge tone={rebuild ? 'warn' : 'info'}>{rebuild ? 'Reconstruction' : u.syncAction.startsWith('check') ? 'Contrôle de parité' : u.syncAction}{u.syncPercent !== undefined && ` ${u.syncPercent.toFixed(1)} %`}</Badge>}
      </>}>
      <Progress percent={u.syncPercent} />
      <UnraidDisks disks={u.disks} />
      {c && (
        <p className={`mt-2 ${c.errors > 0 ? 'text-red-300' : c.exit !== 0 ? 'text-amber-300' : 'text-muted'}`}>
          Dernier contrôle de parité : {dateTime(c.startedAt)}
          {c.finishedAt !== undefined && c.finishedAt > c.startedAt && ` · ${Math.round((c.finishedAt - c.startedAt) / 3_600_000)} h`}
          {' · '}{c.exit !== 0 ? `interrompu (code ${c.exit})` : `${c.errors} erreur(s)`}
        </p>
      )}
      {u.pools.map((p) => (
        <div key={p.name} className="mt-2 border-t border-line/60 pt-2">
          <p className="text-muted">
            <span className="font-mono text-zinc-200">{p.name}</span> · {p.fsType}{p.profile && ` ${p.profile}`} · {p.devices}/{p.devicesExpected} disque(s)
            {p.health && p.health !== 'ONLINE' && <span className="text-red-300"> · {p.health}</span>}
          </p>
          <UnraidDisks disks={p.disks} />
        </div>
      ))}
    </Card>
  );
}

const CEPH_TONES: Record<string, Tone> = { HEALTH_OK: 'ok', HEALTH_WARN: 'warn', HEALTH_ERR: 'bad' };

function CephCluster({ c, cluster, actions }: { c: HealthCeph; cluster?: string; actions?: Actions }) {
  return (
    <Card title="Ceph" meta={cluster ? `cluster ${cluster}` : undefined} actions={actions?.('raid:ceph')}
      badges={c.error ? <Badge tone="bad">Injoignable</Badge> : <Badge tone={CEPH_TONES[c.status ?? ''] ?? 'unknown'}>{c.status}</Badge>}>
      {c.error ? <p className="mt-2 break-words text-red-300">{c.error}</p> : <>
        <p className="mt-2 text-muted">
          OSD {c.osdsUp}/{c.osdsTotal} up, {c.osdsIn}/{c.osdsTotal} in · PG {c.pgsClean}/{c.pgs} active+clean · {formatBytes(c.usedBytes)} / {formatBytes(c.totalBytes)}
        </p>
        {c.checks.length > 0 && (
          <ul className="mt-2 space-y-1">
            {c.checks.map((x) => (
              <li key={x.code} className={x.muted ? 'text-muted' : x.severity === 'HEALTH_ERR' ? 'text-red-300' : 'text-amber-300'} title={x.detail.join('\n')}>
                <span className="font-mono">{x.code}</span> · {x.message}{x.muted && ' (en sourdine)'}
              </li>
            ))}
          </ul>
        )}
        {c.osds.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="text-muted">Sur ce nœud :</span>
            {c.osds.map((o) => (
              <Chip key={o.id} tone={!o.up ? 'bad' : !o.in ? 'warn' : 'ok'}>{o.name}{!o.up ? ' · down' : !o.in ? ' · out' : ''}</Chip>
            ))}
          </div>
        )}
      </>}
    </Card>
  );
}

// RAID of a host, one card each: mdadm arrays, Unraid array and its pools, Ceph cluster (`cluster`: its corosync name).
export function RaidArrays({ raid, cluster, actions }: { raid: HealthRaid; cluster?: string; actions?: Actions }) {
  const count = raid.arrays.length + Number(!!raid.unraid) + Number(!!raid.ceph);
  return (
    <div className={`grid gap-2 ${count > 1 ? 'sm:grid-cols-2' : ''}`}>
      {raid.arrays.map((a) => <MdArray key={a.name} a={a} actions={actions} />)}
      {raid.unraid && <UnraidArray u={raid.unraid} actions={actions} />}
      {raid.ceph && <CephCluster c={raid.ceph} cluster={cluster} actions={actions} />}
    </div>
  );
}
