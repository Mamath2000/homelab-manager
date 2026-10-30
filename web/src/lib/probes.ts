import type { ProbeTarget, ProbeType } from './api';

// Types of probe and how their target reads, shared by the probe components and pages.

export const TYPES: { id: ProbeType; label: string; hint: string }[] = [
  { id: 'mqtt', label: 'MQTT', hint: "Le payload d'un topic contient une valeur, ou un message arrive dans le délai." },
  { id: 'ping', label: 'Ping', hint: "L'adresse répond au ping, depuis le hub ou depuis un hôte avec agent (pour éprouver un lien entre deux sites)." },
  { id: 'tcp', label: 'Port TCP', hint: 'Un port accepte la connexion (DNS, SSH, base de données…).' },
  { id: 'http', label: 'HTTP(S)', hint: 'Une URL répond avec le bon code, et un mot-clé dans la réponse si demandé.' },
];

export function targetText(t: ProbeTarget) {
  switch (t.type) {
    case 'mqtt': return `${t.topic}${t.contains ? ` ≙ ${t.contains}` : ' (message reçu)'}`;
    case 'ping': return t.host;
    case 'tcp': return `${t.host}:${t.port}`;
    case 'http': return `${t.url}${t.status ? ` → ${t.status}` : ''}${t.keyword ? ` ∋ ${t.keyword}` : ''}`;
  }
}
