import { ObjectId } from 'mongodb';
import { logIgnoreRules, parseId } from './db.js';
import type { LogIgnore } from './logs.js';
import type { LogIgnoreRuleDoc } from './types.js';

// Benign messages left out of the journals (homelab#379). Nothing is deleted on the log server and nothing changes on
// the hosts: the routes that show journals add a condition per active rule to their query (filterQuery), the page can
// read them again (showIgnored). The poll that watches silent hosts reads the raw lines; the errors it counts by host
// leave the rules out.

export const MAX_PATTERN = 512;
export const MAX_COMMENT = 500;
const MAX_NAMES = 50;
const NAME_RE = /^[^\s,"]{1,253}$/;

export interface LogIgnoreInput {
  pattern: string;
  regex: boolean;
  hostnames: string[];
  apps: string[];
  comment: string;
  enabled: boolean;
}

export class InvalidRule extends Error {}

const names = (list: string[] | undefined, what: string) => {
  const out = [...new Set((list ?? []).map((n) => n.trim()).filter(Boolean))];
  if (out.length > MAX_NAMES) throw new InvalidRule(`${MAX_NAMES} ${what} au plus`);
  const bad = out.find((n) => !NAME_RE.test(n));
  if (bad) throw new InvalidRule(`${what} invalide : ${bad}`);
  return out;
};

// A rule as it is stored: trimmed, checked. The regular expression is checked as JavaScript reads it here (a pattern
// VictoriaLogs refuses, RE2 being stricter, is caught by the check of the routes on the server).
export function normalizeRule(i: Partial<LogIgnoreInput>): LogIgnoreInput {
  const comment = (i.comment ?? '').trim();
  if (!comment) throw new InvalidRule('commentaire obligatoire : pourquoi ce message est-il bénin ?');
  if (comment.length > MAX_COMMENT) throw new InvalidRule(`commentaire de ${MAX_COMMENT} caractères au plus`);
  return { ...normalizeMatch(i), comment, enabled: i.enabled ?? true };
}

// What a rule matches, checked (the preview of a rule being typed has no comment yet).
export function normalizeMatch(i: Partial<LogIgnoreInput>): Pick<LogIgnoreInput, 'pattern' | 'regex' | 'hostnames' | 'apps'> {
  const pattern = (i.pattern ?? '').trim();
  if (!pattern) throw new InvalidRule('motif vide');
  if (pattern.length > MAX_PATTERN) throw new InvalidRule(`motif de ${MAX_PATTERN} caractères au plus`);
  const regex = !!i.regex;
  if (regex) {
    try {
      new RegExp(pattern.replace(/^\(\?i\)/, ''));
    } catch (err) {
      throw new InvalidRule(`expression régulière invalide : ${(err as Error).message}`);
    }
  }
  return { pattern, regex, hostnames: names(i.hostnames, 'hôtes'), apps: names(i.apps, 'applications') };
}

export const toIgnore = (r: Pick<LogIgnoreRuleDoc, 'pattern' | 'regex' | 'hostnames' | 'apps'>): LogIgnore => ({
  pattern: r.pattern,
  regex: r.regex,
  ...(r.hostnames.length ? { hostnames: r.hostnames } : {}),
  ...(r.apps.length ? { apps: r.apps } : {}),
});

export const listRules = () => logIgnoreRules.find().sort({ at: 1 }).toArray();

// the conditions of the active rules, for the queries
export const loadIgnores = async (): Promise<LogIgnore[]> => (await logIgnoreRules.find({ enabled: true }).sort({ at: 1 }).toArray()).map(toIgnore);

export const ruleById = (id: string) => {
  const _id = parseId(id);
  return _id ? logIgnoreRules.findOne({ _id }) : Promise.resolve(null);
};

export async function createRule(input: LogIgnoreInput, by: string | null, now = new Date()) {
  const doc: LogIgnoreRuleDoc = { _id: new ObjectId(), ...input, by, at: now };
  await logIgnoreRules.insertOne(doc);
  return doc;
}

export async function updateRule(id: ObjectId, input: LogIgnoreInput, by: string | null, now = new Date()) {
  return logIgnoreRules.findOneAndUpdate({ _id: id }, { $set: { ...input, updatedBy: by, updatedAt: now } }, { returnDocument: 'after' });
}

export async function deleteRule(id: ObjectId) {
  return (await logIgnoreRules.deleteOne({ _id: id })).deletedCount > 0;
}

export const ruleDto = (r: LogIgnoreRuleDoc) => ({
  id: r._id.toHexString(),
  pattern: r.pattern,
  regex: r.regex,
  hostnames: r.hostnames,
  apps: r.apps,
  comment: r.comment,
  enabled: r.enabled,
  by: r.by,
  at: r.at.toISOString(),
  ...(r.updatedAt ? { updatedBy: r.updatedBy ?? null, updatedAt: r.updatedAt.toISOString() } : {}),
});
