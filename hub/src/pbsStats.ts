import type { FastifyBaseLogger } from 'fastify';
import { backupStats, settings } from './db.js';
import { groupKey, pbsGet } from './pbs.js';
import type { BackupStatDoc, PbsSettings } from './types.js';

// What each backup really transferred and how long it took, read from the tasks of the main PBS: the
// server log of a backup task ends each archive with "Upload size: <bytes> (<n>%)" (the new chunks
// the client sent; the rest was already in the datastore). Needs Sys.Audit on /system/tasks (the
// monitor token has it, see pbsAgent.ts): without it the PBS only shows the tasks of the token itself.

type Conn = Pick<PbsSettings, 'url' | 'fingerprint' | 'tokenId' | 'tokenSecret'>;

interface ApiTask {
  upid: string;
  worker_type?: string;
  starttime: number; // unix s
  endtime?: number;
  status?: string;
}
interface ApiTaskLine {
  n: number;
  t: string;
}

const DAY = 86_400_000;
const PAGE = 500; // tasks per listing call
const LOG_PAGE = 5000; // lines per log call
const BACKLOG = 400 * DAY; // oldest task read (the PBS keeps its task archive for about as long)
const PER_POLL = 300; // tasks read per poll: the backlog is caught up over a few polls, newest first
const BUDGET_MS = 150_000;

const taskPath = (upid: string) => `/nodes/${encodeURIComponent(upid.split(':')[1] || 'localhost')}/tasks/${encodeURIComponent(upid)}`;
const taskOk = (status?: string) => status === 'OK' || /^WARNINGS: \d+$/.test(status ?? '');

// "starting new backup on datastore 'ds3' from ::ffff:1.2.3.4: "ns/Jarsay/vm/100/2026-05-28T05:00:00Z""
const START_RE = /starting new backup on datastore '([^']+)'.*?"((?:ns\/[^/"]+\/)*)(vm|ct|host)\/([^/"]+)\/[^/"]+"/;
const UPLOAD_RE = /Upload size: (\d+) /;

// Group a log line talks about, and the bytes uploaded for the archive it closes (one of the two or none).
export function parseBackupLine(line: string): { groupId: string } | { uploaded: number } | null {
  const s = START_RE.exec(line);
  if (s) return { groupId: groupKey(s[1], s[2].replace(/(^|\/)ns\//g, '$1').replace(/\/$/, ''), s[3], s[4]) };
  const u = UPLOAD_RE.exec(line);
  return u ? { uploaded: Number(u[1]) } : null;
}

// The group of a finished backup task and what it uploaded in all its archives.
export function parseBackupLog(lines: string[]) {
  let groupId: string | null = null;
  let uploaded = 0;
  for (const l of lines) {
    const p = parseBackupLine(l);
    if (!p) continue;
    if ('groupId' in p) groupId ??= p.groupId;
    else uploaded += p.uploaded;
  }
  return groupId ? { groupId, uploaded } : null;
}

async function listTasks(c: Conn, since: number) {
  const out: ApiTask[] = [];
  for (let start = 0; ; start += PAGE) {
    const page = await pbsGet<ApiTask[]>(c, `/nodes/localhost/tasks?typefilter=backup&limit=${PAGE}&start=${start}&since=${Math.floor(since / 1000)}`);
    out.push(...page.filter((t) => t.worker_type === 'backup' && t.endtime));
    if (page.length < PAGE) return out;
  }
}

// Only the lines that matter are kept: a big VM logs one line per chunk.
async function readLog(c: Conn, upid: string) {
  const keep: string[] = [];
  for (let start = 0; ; start += LOG_PAGE) {
    const page = await pbsGet<ApiTaskLine[]>(c, `${taskPath(upid)}/log?start=${start}&limit=${LOG_PAGE}`, 60_000);
    for (const l of page) if (l.t.includes('starting new backup on') || l.t.includes('Upload size:')) keep.push(l.t);
    if (page.length < LOG_PAGE) return keep;
  }
}

let collecting: Promise<void> | null = null;

// Records the finished backup tasks not seen yet. A failure (token without Sys.Audit, PBS down) is kept in
// the settings of the PBS to be shown, never thrown: the poll of the groups goes on.
export function collectBackupStats(c: Conn, log?: FastifyBaseLogger) {
  collecting ??= doCollect(c, log).finally(() => (collecting = null));
  return collecting;
}

async function doCollect(c: Conn, log?: FastifyBaseLogger) {
  const t0 = Date.now();
  try {
    const listed = (await listTasks(c, t0 - BACKLOG)).sort((a, b) => b.starttime - a.starttime);
    const known = new Set((await backupStats.find({ _id: { $in: listed.map((t) => t.upid) } }, { projection: { _id: 1 } }).toArray()).map((d) => d._id));
    const todo = listed.filter((t) => !known.has(t.upid)).slice(0, PER_POLL);
    let n = 0;
    for (const t of todo) {
      if (Date.now() - t0 > BUDGET_MS) break;
      const ok = taskOk(t.status);
      // a failed task has no useful statistics, only its group (head of its log) and its duration
      const head = parseBackupLog(ok ? await readLog(c, t.upid) : await readHead(c, t.upid));
      if (!head) {
        // not a snapshot backup we can attribute (aborted before it started): remember it, read it once
        await backupStats.updateOne({ _id: t.upid }, { $set: { groupId: '', start: t.starttime * 1000, end: t.endtime! * 1000, uploaded: 0, ok, at: new Date(t.starttime * 1000) } }, { upsert: true });
        continue;
      }
      const doc: BackupStatDoc = { _id: t.upid, groupId: head.groupId, start: t.starttime * 1000, end: t.endtime! * 1000, uploaded: ok ? head.uploaded : 0, ok, at: new Date(t.starttime * 1000) };
      await backupStats.replaceOne({ _id: doc._id }, doc, { upsert: true });
      n++;
    }
    await settings.updateOne({ _id: 'pbs' }, { $set: { statsError: null } });
    if (todo.length) log?.info({ read: n, remaining: Math.max(0, listed.length - known.size - todo.length) }, 'PBS backup statistics collected');
  } catch (err) {
    const m = (err as Error).message;
    const msg = /403|refus/.test(m) ? 'le jeton de supervision ne peut pas lire les tâches du PBS : lui ajouter le droit Sys.Audit (relancer l’étape « Jeton » du PBS)' : m;
    await settings.updateOne({ _id: 'pbs' }, { $set: { statsError: msg } });
    log?.warn({ err }, 'PBS backup statistics not collected');
  }
}

async function readHead(c: Conn, upid: string) {
  const page = await pbsGet<ApiTaskLine[]>(c, `${taskPath(upid)}/log?start=0&limit=20`).catch(() => []);
  return page.map((l) => l.t);
}

// --- daily series -------------------------------------------------------------------------

export interface StatDay {
  day: number; // unix ms, local midnight
  uploaded: number; // bytes
  duration: number; // ms, backups of the day added up
  count: number;
  failed: number;
}

const midnight = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// One cell per day, oldest first, ending today.
export function dailySeries(docs: Pick<BackupStatDoc, 'start' | 'end' | 'uploaded' | 'ok'>[], days: number, now = Date.now()): StatDay[] {
  const today = midnight(now);
  const cells: StatDay[] = Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1 - i));
    return { day: d.getTime(), uploaded: 0, duration: 0, count: 0, failed: 0 };
  });
  const byDay = new Map(cells.map((c) => [c.day, c]));
  for (const s of docs) {
    const c = byDay.get(midnight(s.start));
    if (!c) continue;
    c.uploaded += s.uploaded;
    c.duration += Math.max(0, s.end - s.start);
    c.count++;
    if (!s.ok) c.failed++;
  }
  return cells;
}

export async function statsView(days: number, now = Date.now()) {
  const from = midnight(now) - (days - 1) * DAY - DAY; // a margin for the daylight saving shifts
  const docs = await backupStats.find({ start: { $gte: from }, groupId: { $ne: '' } }).toArray();
  const byGroup = new Map<string, BackupStatDoc[]>();
  for (const d of docs) byGroup.set(d.groupId, [...(byGroup.get(d.groupId) ?? []), d]);
  return {
    days: dailySeries(docs, days, now),
    // the last 30 days of each group, for the bars of its line
    groups: Object.fromEntries([...byGroup].map(([id, list]) => [id, dailySeries(list, 30, now).map((c) => ({ uploaded: c.uploaded, duration: c.duration, failed: c.failed }))])),
  };
}
