import { backups } from './db.js';
import { publish } from './events.js';
import { HISTORY } from './pbs.js';
import type { BackupDoc, BackupHa, HostDoc } from './types.js';

// Backups of Home Assistant on a HAOS host, reported by its agent (agent/habackup.go): one group per
// destination (backup agent of Core: local, SFTP...). Read only: Home Assistant makes them, the hub
// only follows them. They are not on the PBS: the PBS poll leaves them alone.

// Report of the agent (ha_backups); dates in unix ms, 0 = unknown.
export interface HaBackupReport {
  checkedAt: number;
  configured: boolean;
  recurrence: string; // never | daily | custom_days
  days: string[];
  time: string; // HH:MM, "" = chosen by Home Assistant
  timeZone?: string;
  autoAgentIds: string[];
  lastAttempted: number;
  lastCompleted: number;
  next: number;
  state: string;
  agents: {
    agentId: string;
    name: string;
    backups: { id: string; name: string; date: number; size: number; automatic: boolean }[];
    failedAt?: number;
    error?: string;
  }[];
}

export function isHaBackupReport(r: unknown): r is HaBackupReport {
  const x = r as HaBackupReport;
  return (
    !!x &&
    typeof x.checkedAt === 'number' &&
    typeof x.configured === 'boolean' &&
    Array.isArray(x.autoAgentIds) &&
    Array.isArray(x.agents) &&
    x.agents.every((a) => !!a && typeof a.agentId === 'string' && typeof a.name === 'string' && Array.isArray(a.backups) && a.backups.every((b) => typeof b?.date === 'number'))
  );
}

export const haGroupId = (hostId: HostDoc['_id'], agentId: string) => `haos/${hostId.toHexString()}/${agentId}`;

export interface HaGroup {
  _id: string;
  // fields always written
  set: Pick<BackupDoc, 'store' | 'ns' | 'type' | 'backupId' | 'ha'>;
  // history, absent when the destination could not be listed (the last known one is kept)
  history: Pick<BackupDoc, 'count' | 'size' | 'lastBackup' | 'times'> | null;
}

// Groups of a report: the destinations of the automatic backups, and the others holding backups (an
// unused backup agent, Home Assistant Cloud without subscription..., is not followed).
export function haGroups(hostId: HostDoc['_id'], r: HaBackupReport): HaGroup[] {
  const auto = new Set(r.autoAgentIds);
  const automaticOn = r.configured && r.recurrence !== 'never';
  const schedule: BackupHa['schedule'] = r.recurrence && r.recurrence !== 'never' ? { recurrence: r.recurrence, days: r.days ?? [], time: r.time || null } : null;
  const out: HaGroup[] = [];
  for (const a of r.agents) {
    if (!auto.has(a.agentId) && !a.backups.length) continue;
    const sorted = [...a.backups].sort((x, y) => y.date - x.date);
    out.push({
      _id: haGroupId(hostId, a.agentId),
      set: {
        store: 'Home Assistant',
        ns: '',
        type: 'ha',
        backupId: a.name || a.agentId,
        ha: {
          agentId: a.agentId,
          automatic: automaticOn && auto.has(a.agentId),
          schedule,
          tz: r.timeZone || 'UTC',
          next: r.next || null,
          lastAttempted: r.lastAttempted || null,
          lastCompleted: r.lastCompleted || null,
          failedAt: a.failedAt || null,
          error: a.error || null,
        },
      },
      history:
        a.error && !a.backups.length
          ? null
          : {
              count: sorted.length,
              size: sorted[0]?.size ?? null,
              lastBackup: sorted[0]?.date ?? 0,
              times: sorted
                .slice(0, HISTORY)
                .map((b) => ({ t: b.date, verify: null }))
                .reverse(),
            },
    });
  }
  return out;
}

// Upsert of the groups of a HAOS host; a destination no longer reported (removed from Home Assistant)
// is deleted: it was a choice made in Home Assistant, not a loss.
export async function refreshHaBackups(hostId: HostDoc['_id'], r: HaBackupReport) {
  const now = new Date();
  const groups = haGroups(hostId, r);
  for (const g of groups) {
    await backups.updateOne(
      { _id: g._id },
      {
        $set: { ...g.set, ...(g.history ?? {}), hostId, source: 'haos', verify: null, retention: null, seenAt: now },
        $setOnInsert: g.history ? {} : { count: 0, size: null, lastBackup: 0, times: [] },
        $unset: { gone: '' },
      },
      { upsert: true },
    );
  }
  await backups.deleteMany({ source: 'haos', hostId, _id: { $nin: groups.map((g) => g._id) } });
  publish('backups', {});
}
