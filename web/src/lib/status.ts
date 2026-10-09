import type { DockerStack, Host, ImageUpdate, StackStatus } from './api';

// Shared colour vocabulary, Komodo-like: green ok, amber warning, red critical, violet unknown, sky in progress.
export type Tone = 'ok' | 'warn' | 'bad' | 'unknown' | 'info' | 'neutral';

export const toneText: Record<Tone, string> = {
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  bad: 'text-red-400',
  unknown: 'text-violet-400',
  info: 'text-sky-400',
  neutral: 'text-zinc-400',
};

export const toneStroke: Record<Tone, string> = {
  ok: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  unknown: '#a78bfa',
  info: '#38bdf8',
  neutral: '#52525b',
};

export const toneBadge: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25',
  warn: 'bg-amber-500/10 text-amber-300 ring-amber-500/25',
  bad: 'bg-red-500/10 text-red-300 ring-red-500/25',
  unknown: 'bg-violet-500/10 text-violet-300 ring-violet-500/25',
  info: 'bg-sky-500/10 text-sky-300 ring-sky-500/25',
  neutral: 'bg-zinc-500/10 text-zinc-300 ring-zinc-500/25',
};

export type Connection = 'online' | 'offline' | 'pending';

export function connection(h: Host): Connection {
  if (h.online) return 'online';
  return h.enrolledAt ? 'offline' : 'pending';
}

export const connectionMeta: Record<Connection, { label: string; tone: Tone }> = {
  online: { label: 'En ligne', tone: 'ok' },
  offline: { label: 'Hors ligne', tone: 'bad' },
  pending: { label: 'En attente', tone: 'unknown' },
};

export type UpdateState = 'security' | 'reboot' | 'updates' | 'uptodate' | 'unknown';

export function updateState(h: Host): UpdateState {
  const s = h.aptSummary;
  if (!s) return 'unknown';
  // a pending reboot comes first: the updates already installed are not active yet
  if (s.rebootRequired) return 'reboot';
  if (s.security > 0) return 'security';
  if (s.upgradable > 0) return 'updates';
  return 'uptodate';
}

export const updateMeta: Record<UpdateState, { label: string; tone: Tone }> = {
  uptodate: { label: 'À jour', tone: 'ok' },
  updates: { label: 'Mises à jour', tone: 'warn' },
  security: { label: 'Sécurité', tone: 'bad' },
  reboot: { label: 'Reboot requis', tone: 'info' },
  unknown: { label: 'Inconnu', tone: 'unknown' },
};

const STALE_MS = 2 * 24 * 3600 * 1000;

// Package lists older than two days mean the update counts can't be trusted.
export function listsStale(h: Host) {
  const t = h.apt?.listsUpdatedAt;
  return !!h.apt && (!t || Date.now() - t > STALE_MS);
}

export function osLabel(h: Host) {
  if (!h.info) return null;
  return h.info.osName.replace(/ GNU\/Linux/, '').replace(/ LTS$/, '');
}

export const canSelfUpdate = (h: Host) => h.capabilities.includes('agent_update');

// Agent still on the plain-text token of the first versions: refused by the hub, to reinstall.
export const needsReinstall = (h: Host) => h.agentAuth === 'legacy';
// Enrolled once, but its certificate was revoked.
export const agentRevoked = (h: Host) => h.agentAuth === 'none' && !!h.enrolledAt;

export const stackMeta: Record<StackStatus, { label: string; tone: Tone }> = {
  running: { label: 'En marche', tone: 'ok' },
  partial: { label: 'Partielle', tone: 'warn' },
  stopped: { label: 'Arrêtée', tone: 'neutral' },
  down: { label: 'Down', tone: 'unknown' },
};

export const imageUpdateMeta: Record<ImageUpdate, { label: string; tone: Tone; hint: string }> = {
  available: { label: 'Mise à jour', tone: 'warn', hint: 'Une image plus récente est disponible sur le registre' },
  recreate: { label: 'À redéployer', tone: 'info', hint: "Nouvelle image déjà téléchargée, le conteneur tourne encore sur l'ancienne" },
  uptodate: { label: 'À jour', tone: 'ok', hint: 'Image identique à celle du registre' },
  unknown: { label: 'Inconnu', tone: 'unknown', hint: 'Jamais vérifiée, ou non vérifiable (image locale, digest épinglé, registre privé)' },
};

export interface HostStack extends DockerStack {
  host: Host;
}

// Every stack of every host, for the Docker page and the dashboard.
export function allStacks(hosts: Host[]): HostStack[] {
  return hosts
    .flatMap((host) => (host.docker?.stacks ?? []).map((st) => ({ ...st, host })))
    .sort((a, b) => a.name.localeCompare(b.name) || a.host.name.localeCompare(b.host.name));
}

export const stackPath = (hostId: string, stack: string) => `/docker/${hostId}/${encodeURIComponent(stack)}`;
