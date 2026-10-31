import type { ProbeTarget, ProbeType } from './api';

// Types of probe and how their target reads, shared by the probe components and pages.

// auto: made by the hub (VPN of Omada), never offered in the form of a probe
export const TYPES: { id: ProbeType; label: string; hint: string; short: string; auto?: boolean }[] = [
  { id: 'mqtt', short: 'Un topic publie la bonne valeur.', label: 'MQTT', hint: "Le payload d'un topic contient une valeur, ou un message arrive dans le délai." },
  { id: 'ping', short: "Une adresse répond, du hub ou d'un hôte.", label: 'Ping', hint: "L'adresse répond au ping, depuis le hub ou depuis un hôte avec agent (pour éprouver un lien entre deux sites)." },
  { id: 'tcp', short: 'Un port accepte la connexion.', label: 'Port TCP', hint: 'Un port accepte la connexion (DNS, SSH, base de données…).' },
  { id: 'http', short: 'Une URL répond comme attendu.', label: 'HTTP(S)', hint: 'Une URL répond avec le bon code, et un mot-clé dans la réponse si demandé.' },
  { id: 'vpn', short: 'Le trafic passe dans un tunnel site à site.', label: 'VPN', hint: "Un hôte d'un côté du tunnel pingue une machine de l'autre côté.", auto: true },
];

export function targetText(t: ProbeTarget) {
  switch (t.type) {
    case 'mqtt': return `${t.topic}${t.contains ? ` ≙ ${t.contains}` : ' (message reçu)'}`;
    case 'ping': return t.host;
    case 'tcp': return `${t.host}:${t.port}`;
    case 'http': return `${t.url}${t.status ? ` → ${t.status}` : ''}${t.keyword ? ` ∋ ${t.keyword}` : ''}`;
    case 'vpn': return t.host ? `→ ${t.host}` : 'cible à choisir';
  }
}
