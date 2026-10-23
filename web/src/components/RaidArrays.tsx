import type { ReactNode } from 'react';
import type { HealthRaidArray } from '../lib/api';
import type { Tone } from '../lib/status';
import { Badge } from './ui';

const SYNC_LABELS: Record<string, string> = { check: 'Contrôle', repair: 'Réparation', resync: 'Resynchro', recover: 'Reconstruction', reshape: 'Remodelage' };

function arrayStatus(a: HealthRaidArray): { tone: Tone; label: string } {
  if (a.degraded > 0) return { tone: 'bad', label: 'Dégradé' };
  if (['inactive', 'readonly', 'broken', 'suspended', 'clear'].includes(a.state)) return { tone: 'bad', label: a.state };
  if (a.state === 'read-auto') return { tone: 'warn', label: 'read-auto' };
  return { tone: 'ok', label: 'Sain' };
}

// Linux software RAID (mdadm) arrays of a host, one card each; `actions` adds e.g. the accept button of the array's alerts.
export function RaidArrays({ arrays, actions }: { arrays: HealthRaidArray[]; actions?: (a: HealthRaidArray) => ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {arrays.map((a) => {
        const status = arrayStatus(a);
        const sync = SYNC_LABELS[a.syncAction];
        return (
          <div key={a.name} className="min-w-0 rounded-md border border-line bg-raised/20 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono font-medium text-zinc-100">{a.name}</span>
              <span className="text-muted">{a.level} · {a.raidDisks - a.degraded}/{a.raidDisks} disques</span>
              <Badge tone={status.tone}>{status.label}</Badge>
              {sync && <Badge tone={a.syncAction === 'check' || a.syncAction === 'repair' ? 'info' : 'warn'}>{sync}{a.syncPercent !== undefined && ` ${a.syncPercent.toFixed(1)} %`}</Badge>}
              {a.mismatchCount > 0 && <span className="text-amber-300">{a.mismatchCount} incohérences</span>}
              {actions && <span className="ml-auto">{actions(a)}</span>}
            </div>
            {a.syncPercent !== undefined && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/30"><div className="h-full bg-sky-400" style={{ width: `${a.syncPercent}%` }} /></div>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {a.members.map((m) => {
                const faulty = m.state.split(',').includes('faulty');
                return (
                  <span key={m.device} title={`${m.state}${m.slot !== undefined ? ` · slot ${m.slot}` : ''} · ${m.errors} erreur(s) de lecture corrigée(s)`}
                    className={`rounded-sm px-1.5 py-0.5 font-mono ring-1 ring-inset ${faulty ? 'text-red-300 ring-red-400/40' : m.errors > 0 ? 'text-amber-300 ring-amber-400/40' : 'text-zinc-300 ring-line'}`}>
                    {m.device}{!m.state.includes('in_sync') && ` · ${m.state}`}{m.errors > 0 && ` · ${m.errors} err.`}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
