import type { Host } from './api';

// Automatic security updates of a host (homelab#233): its choice (options) against what its agent reports.
export const canAutoUpgrade = (h: Pick<Host, 'capabilities'>) => h.capabilities.includes('apt_auto');

export interface AutoUpgradeState {
  tone: 'ok' | 'neutral' | 'warn';
  title: string;
}

// null: nothing to show (not chosen, and not running on the host)
export function autoUpgradeState(h: Pick<Host, 'autoSecurityUpdates' | 'apt' | 'online'>): AutoUpgradeState | null {
  const auto = h.apt?.auto;
  const pending = h.online ? 'pas encore appliquées' : 'appliquées au retour de l’hôte';
  if (!auto) return h.autoSecurityUpdates ? { tone: 'warn', title: `Mises à jour de sécurité automatiques choisies, ${pending}` } : null;
  if (h.autoSecurityUpdates && !auto.managed) return { tone: 'warn', title: `Mises à jour de sécurité automatiques choisies, ${pending}` };
  if (!h.autoSecurityUpdates && auto.managed) return { tone: 'warn', title: 'Mises à jour de sécurité automatiques en cours de retrait' };
  if (auto.managed) {
    return auto.enabled
      ? { tone: 'ok', title: 'Mises à jour de sécurité automatiques actives (unattended-upgrades, sécurité seulement, sans redémarrage)' }
      : { tone: 'warn', title: 'Mises à jour de sécurité automatiques : fichier en place mais désactivé par une autre configuration' };
  }
  return auto.enabled ? { tone: 'neutral', title: 'unattended-upgrades actif hors Homelab Manager (configuration de la distribution)' } : null;
}
