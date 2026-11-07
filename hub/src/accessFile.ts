import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBundle, accessSummary } from './access.js';
import { config } from './config.js';
import { settings } from './db.js';
import { checkAllHosts, loadAccess, loadSetupProfile, profileError } from './setup.js';
import type { AccessBundle, AccessSettings, SetupProfile } from './types.js';

// The signed access manifest is not uploaded: `make access-publish` drops it in a folder the hub reads (read only
// mount, compose.yml). The hub checks it like any bundle and keeps it; the agents check it again against their own
// anchor, so the folder is a relay, not a source of trust.

export const ACCESS_FILE = 'manifest.sig.json';

export interface AccessSync {
  state: 'none' | 'ok' | 'error';
  detail?: string;
  at: number;
}

export type FileRead = { bundle: AccessBundle } | { missing: true } | { error: string };

export function readBundleFile(dir: string): FileRead {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ACCESS_FILE), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { missing: true } : { error: `${ACCESS_FILE} illisible : ${(err as Error).message}` };
  }
  try {
    const b = JSON.parse(raw) as Partial<AccessBundle>;
    if (typeof b.payload !== 'string' || typeof b.signature !== 'string') return { error: `${ACCESS_FILE} : champs payload et signature attendus` };
    return { bundle: { payload: b.payload, signature: b.signature } };
  } catch {
    return { error: `${ACCESS_FILE} : JSON invalide` };
  }
}

// What to do with the bundle found in the folder: nothing (already loaded), refuse (error), or replace the stored one.
export function evaluateBundle(b: AccessBundle, current: AccessSettings | null, profile: SetupProfile): { unchanged: true } | { error: string } | { next: AccessSettings } {
  if (current && current.bundle.payload === b.payload && current.bundle.signature === b.signature) return { unchanged: true };
  let checked: ReturnType<typeof checkBundle>;
  try {
    checked = checkBundle(b);
  } catch (err) {
    return { error: (err as Error).message };
  }
  // the hosts refuse an older serial anyway: a bundle that cannot apply is refused here
  if (current && checked.manifest.serial <= current.manifest.serial) {
    return { error: `numéro de série ${checked.manifest.serial} : le manifeste actif porte déjà le ${current.manifest.serial}, le suivant doit être plus grand` };
  }
  const next: AccessSettings = { _id: 'access', bundle: b, manifest: checked.manifest, signer: checked.signer, uploadedAt: new Date() };
  const lock = profileError({ ...profile, access: next });
  return lock ? { error: lock } : { next };
}

let last: AccessSync = { state: 'none', at: 0 };
export const accessSyncState = () => last;

// Reads the folder and loads a new manifest. Never throws: the outcome is the state shown in Paramètres.
export async function syncAccessFile(log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }): Promise<AccessSync> {
  const at = Date.now();
  const read = readBundleFile(config.accessDir);
  let next: AccessSync;
  if ('missing' in read) {
    next = { state: 'none', at };
  } else if ('error' in read) {
    next = { state: 'error', detail: read.error, at };
  } else {
    const res = evaluateBundle(read.bundle, await loadAccess(), await loadSetupProfile());
    if ('error' in res) {
      next = { state: 'error', detail: res.error, at };
    } else {
      if ('next' in res) {
        await settings.replaceOne({ _id: 'access' }, res.next, { upsert: true });
        log?.info({ serial: res.next.manifest.serial, signer: res.next.signer }, 'access manifest loaded');
        // conformity is measured against the manifest: check every host again
        checkAllHosts().catch((e) => log?.warn({ err: e }, 'standardisation check failed'));
      }
      next = { state: 'ok', at };
    }
  }
  if (next.state === 'error' && last.detail !== next.detail) log?.warn({ detail: next.detail }, 'access manifest refused');
  last = next;
  return next;
}

export async function accessView() {
  return { access: accessSummary(await loadAccess()), sync: last };
}

export function startAccessSync(log: Parameters<typeof syncAccessFile>[0]) {
  const run = () => syncAccessFile(log).catch((err) => log?.warn({ err }, 'access sync failed'));
  void run();
  const timer = setInterval(run, 30_000);
  return () => clearInterval(timer);
}
