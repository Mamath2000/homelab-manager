import { useCallback, useState } from 'react';
import { visibleHealthVolumes, type AlertLevel, type DayAlert, type Host, type HostStatus, type Probe } from './api';
import type { BackupGroup } from './api';
import { dateTime, timeAgo } from './format';
import { hostMqttBrokers } from './roles';

// Cards of the host page, in the order they are stacked. In the reduced display each one is a row of fixed height:
// level (the one of the monitoring domains of the hub), a short text saying what is wrong, or else what is fine,
// and a small visual.
export type CardKey = 'health' | 'ups' | 'apt' | 'docker' | 'mqtt' | 'probes' | 'sessions' | 'system' | 'backups';

// Fixed column of each card on wide screens: a card is always found on the same side, whatever the host
export const cardColumn: Record<CardKey, 0 | 1> = { health: 0, ups: 0, apt: 0, docker: 0, mqtt: 1, probes: 1, sessions: 1, system: 1, backups: 1 };

// Monitoring domains (hub/src/monitoring.ts) each card takes its level from; none: a card without level, neutral
const cardDomains: Record<CardKey, string[]> = {
  health: ['health'],
  ups: ['ups'],
  apt: ['apt'],
  docker: ['docker'],
  probes: ['services'],
  backups: ['backup', 'offsite'],
  mqtt: [],
  sessions: [],
  system: [],
};

export type CardLevel = AlertLevel | 'none';

export interface CardState {
  level: CardLevel;
  // reasons of what is not ok, the most serious first
  reasons: string[];
}

export function cardState(status: HostStatus | undefined, key: CardKey): CardState {
  const domains = cardDomains[key].map((d) => status?.domains[d]).filter((d) => !!d && d.level !== 'unknown');
  if (!domains.length) return { level: 'none', reasons: [] };
  const checks = domains.flatMap((d) => d!.checks).filter((c) => c.level !== 'ok' && c.reason);
  checks.sort((a, b) => Number(b.level === 'alert') - Number(a.level === 'alert'));
  const level: AlertLevel = domains.some((d) => d!.level === 'alert') ? 'alert' : domains.some((d) => d!.level === 'warn') ? 'warn' : 'ok';
  return { level, reasons: checks.map((c) => c.reason!) };
}

// "First reason + n others", or the summary of what is fine
export function cardText(state: CardState, summary: string): string {
  if (state.level === 'none' || state.level === 'ok' || !state.reasons.length) return summary;
  return state.reasons.length > 1 ? `${state.reasons[0]} · + ${state.reasons.length - 1} autre${state.reasons.length > 2 ? 's' : ''}` : state.reasons[0];
}

export type CardVisual =
  | { kind: 'bars'; items: { label: string; percent: number }[] }
  | { kind: 'battery'; percent: number }
  | { kind: 'dots'; levels: CardLevel[] }
  | { kind: 'days'; levels: CardLevel[] }
  | { kind: 'count'; value: string; label: string };

export interface CardInfo {
  summary: string;
  visual?: CardVisual;
}

const pct = (n: number) => `${Number(n.toFixed(1)).toLocaleString('fr-FR')} %`;

// The last 14 days of the domains of a card, from the history of the alert timeline
export function recentDays(days: { day: string; domains: Record<string, DayAlert | null> }[] | undefined, key: CardKey, n = 14): CardLevel[] {
  const domains = cardDomains[key];
  const byDay = new Map((days ?? []).map((d) => [d.day, d]));
  const out: CardLevel[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cells = domains.map((dom) => byDay.get(k)?.domains[dom]).filter((c): c is DayAlert => !!c);
    out.push(!cells.length ? 'none' : cells.some((c) => c.level === 'alert') ? 'alert' : cells.some((c) => c.level === 'warn') ? 'warn' : 'ok');
  }
  return out;
}

const gaugeLevel = (p: number): CardLevel => (p >= 90 ? 'alert' : p >= 75 ? 'warn' : 'ok');
export { gaugeLevel };

export function healthInfo(host: Host): CardInfo {
  const s = host.health?.system;
  const volumes = visibleHealthVolumes(host.health?.disks?.volumes ?? []);
  const vol = volumes.length ? Math.max(...volumes.map((v) => v.percent)) : undefined;
  const smart = host.health?.smart?.disks.filter((d) => !d.standby || d.healthy !== undefined) ?? [];
  const parts = [
    s && `CPU ${pct(s.cpuPercent)}`,
    s && `mémoire ${pct(s.memPercent)}`,
    vol !== undefined && `${volumes.length > 1 ? 'volumes' : 'volume'} ${pct(vol)}`,
    smart.length > 0 && `SMART ${smart.filter((d) => d.healthy !== false).length}/${smart.length}`,
  ].filter((p): p is string => typeof p === 'string');
  const items = [s && { label: 'CPU', percent: s.cpuPercent }, s && { label: 'Mém', percent: s.memPercent }, vol !== undefined && { label: 'Vol', percent: vol }].filter((i): i is { label: string; percent: number } => !!i);
  return { summary: parts.join(' · ') || 'Pas encore de mesure', visual: items.length ? { kind: 'bars', items } : undefined };
}

export function upsInfo(host: Host): CardInfo {
  const u = host.ups;
  if (!u) return { summary: '' };
  const flags = u.status.split(/\s+/);
  const state = flags.includes('OB') ? 'Sur batterie' : flags.includes('OL') ? 'Sur secteur' : u.status;
  const parts = [state, u.charge !== undefined && `batterie ${Math.round(u.charge)} %`, u.runtime !== undefined && `autonomie ${Math.round(u.runtime / 60)} min`].filter((p): p is string => typeof p === 'string');
  return { summary: parts.join(' · '), visual: u.charge !== undefined ? { kind: 'battery', percent: u.charge } : undefined };
}

export function aptInfo(host: Host, days: CardLevel[]): CardInfo {
  const a = host.aptSummary;
  const base = !a ? 'Pas encore de relevé' : a.upgradable === 0 ? `À jour · listes du ${dateTime(host.apt?.listsUpdatedAt)}` : `${a.upgradable} paquet${a.upgradable > 1 ? 's' : ''} à mettre à jour${a.security ? ` dont ${a.security} de sécurité` : ''}`;
  return { summary: base, visual: { kind: 'days', levels: days } };
}

export function dockerInfo(host: Host): CardInfo {
  const stacks = host.docker?.stacks ?? [];
  const sum = host.dockerSummary;
  const levels: CardLevel[] = stacks.map((st) => (!st.managed ? 'none' : st.problems.length || st.status !== 'running' ? 'alert' : st.updates > 0 ? 'warn' : 'ok'));
  const running = sum?.running ?? stacks.filter((st) => st.status === 'running').length;
  const total = sum?.stacks ?? stacks.length;
  const updates = sum?.updates ?? 0;
  return { summary: `${running}/${total} stack${total > 1 ? 's' : ''} en marche · ${updates ? `${updates} image${updates > 1 ? 's' : ''} à mettre à jour` : 'images à jour'}`, visual: { kind: 'dots', levels } };
}

export function probesInfo(probes: Probe[] | undefined): CardInfo {
  if (!probes?.length) return { summary: 'Aucune sonde configurée', visual: { kind: 'count', value: '—', label: 'aucune sonde' } };
  const up = probes.filter((p) => p.state === 'up').length;
  const lat = Math.max(0, ...probes.map((p) => p.latencyMs ?? 0));
  return {
    summary: `${up}/${probes.length} sonde${probes.length > 1 ? 's' : ''} up${lat ? ` · réponse max ${Math.round(lat)} ms` : ''}`,
    visual: { kind: 'dots', levels: probes.map((p) => (p.state === 'up' ? 'ok' : p.state === 'down' ? 'alert' : 'none')) },
  };
}

export function mqttInfo(host: Host): CardInfo {
  const brokers = hostMqttBrokers(host);
  return { summary: `Broker ${brokers.map((b) => b.name).join(', ')} · rôle du hub`, visual: { kind: 'count', value: String(brokers.length), label: brokers.length > 1 ? 'brokers' : 'broker' } };
}

export function sessionsInfo(host: Host): CardInfo {
  const s = host.sessionSummary;
  if (!s) return { summary: 'Pas encore de relevé', visual: { kind: 'count', value: '—', label: 'session' } };
  const n = host.sessions?.sessions.length ?? 0;
  const text = `${s.users.length} utilisateur${s.users.length > 1 ? 's' : ''} · ${n} session${n > 1 ? 's' : ''}${s.loggedIn ? (s.locked ? ' · verrouillée' : s.interactive ? ' · activité clavier/souris' : '') : ''}`;
  return { summary: s.users.length ? `${text} (${s.users.join(', ')})` : 'Aucune session ouverte', visual: { kind: 'count', value: String(n), label: n > 1 ? 'sessions' : 'session' } };
}

export function backupsInfo(host: Host, groups: BackupGroup[] | undefined, days: CardLevel[]): CardInfo {
  const mine = (groups ?? []).filter((g) => g.hostId === host.id);
  if (!mine.length) return { summary: 'Aucune sauvegarde rattachée', visual: { kind: 'count', value: '—', label: 'à rattacher' } };
  const last = Math.max(...mine.map((g) => g.lastBackup));
  const verified = mine.every((g) => g.verify !== 'failed');
  return { summary: `${mine.length} sauvegarde${mine.length > 1 ? 's' : ''} · dernière ${timeAgo(last)}${verified ? '' : ' · vérification en échec'}`, visual: { kind: 'days', levels: days } };
}

// Expanded cards, remembered by browser (reduced by default)
const STORE = 'hm.hostCards.expanded';
export function useExpandedCards() {
  const [open, setOpen] = useState<CardKey[]>(() => {
    try {
      const raw = localStorage.getItem(STORE);
      return raw ? (JSON.parse(raw) as CardKey[]) : [];
    } catch {
      return [];
    }
  });
  const save = useCallback((next: CardKey[]) => {
    setOpen(next);
    try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* private mode: kept until reload */ }
  }, []);
  const toggle = useCallback((key: CardKey) => save(open.includes(key) ? open.filter((k) => k !== key) : [...open, key]), [open, save]);
  return { open, toggle, setAll: save };
}
