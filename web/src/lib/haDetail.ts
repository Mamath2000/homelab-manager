import type { HaLevel, HaSection } from './api';

export const HA_LEVELS: { id: HaLevel; label: string; hint: string }[] = [
  { id: 'minimal', label: 'Minimal', hint: 'Alertes, connectivité des hôtes et top 5 seulement' },
  { id: 'standard', label: 'Standard', hint: 'Minimal + compteurs et sous-composants (APT, Docker, onduleur, sauvegardes) et sondes, sans actions ni diagnostics' },
  { id: 'full', label: 'Complet', hint: 'Tout : actions, diagnostics, sessions Windows' },
];

export const HA_SECTIONS: { id: HaSection; label: string; hint: string }[] = [
  { id: 'tops', label: 'Top 5 CPU / mémoire / disque', hint: 'Trois capteurs sur Homelab Manager' },
  { id: 'counters', label: 'Compteurs', hint: 'Hôtes, mises à jour, stacks, sauvegardes en retard, datastores' },
  { id: 'apt', label: 'APT', hint: 'Sous-composant par hôte, état « redémarrage requis »' },
  { id: 'docker', label: 'Docker', hint: 'Un sous-composant par stack' },
  { id: 'ups', label: 'Onduleur', hint: 'Sous-composant par hôte avec onduleur NUT' },
  { id: 'backup', label: 'Sauvegardes', hint: 'Sous-composant par hôte sauvegardé' },
  { id: 'probes', label: 'Sondes', hint: 'Une entité par sonde de service, sur l\'hôte ou sa stack ; indisponible quand la sonde est inconnue' },
  { id: 'sessions', label: 'Sessions Windows', hint: 'Utilisateurs connectés, session verrouillée…' },
  { id: 'actions', label: 'Actions', hint: 'Boutons et mises à jour installables depuis Home Assistant' },
  { id: 'diagnostics', label: 'Diagnostics', hint: 'Système, noyau, IP, dernière vue, alertes des sous-composants' },
];

// sections published per host; counters and tops are on the hub's device and follow the global level only
export const HA_HOST_SECTIONS: HaSection[] = ['apt', 'docker', 'ups', 'backup', 'probes', 'sessions', 'actions', 'diagnostics'];
