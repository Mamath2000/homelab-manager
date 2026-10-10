import { Server, User, UserCog, type LucideIcon } from 'lucide-react';
import type { Host, SetupOption, SetupOptions, SetupOverrides, SetupValues } from './api';

// Hosts where the standardisation exists, or will once their agent is updated.
export const showSetup = (host: Host) => host.capabilities.includes('setup') || !!host.apt;

export type SetupSection = 'system' | 'root' | 'user';
export const sectionIcons: Record<SetupSection, LucideIcon> = { system: Server, root: UserCog, user: User };

// Sections of the standardisation, in display order.
export const setupSections: { id: SetupSection; title: string; hint: string; options: SetupOption[] }[] = [
  { id: 'system', title: 'Système', hint: "S'applique à la machine.", options: ['packages', 'ssh_password'] },
  { id: 'root', title: 'root', hint: 'Compte root : ses clés, son shell.', options: ['root_keys', 'root_aliases', 'root_prompt', 'root_motd'] },
  {
    id: 'user',
    title: 'Utilisateur',
    hint: 'Compte créé en plus de root, avec ses propres valeurs.',
    options: ['user', 'user_keys', 'user_aliases', 'user_prompt', 'user_motd'],
  },
];

const keysHint = 'Ajoute les clés manquantes à ~/.ssh/authorized_keys ; les autres clés sont gardées.';
const aliasesHint = '~/.bash_aliases, chargé par ~/.bashrc.';
const promptHint = 'Invite de commande : classique colorée (rouge pour root, branche git) ou Starship.';
const motdHint = 'Affiché à la connexion : résumé homelab (instantané) ou fastfetch (configuration commune, /etc/homelab/fastfetch.jsonc).';

export const setupOptionInfo: Record<SetupOption, { label: string; hint: string }> = {
  packages: { label: 'Paquets', hint: 'Installe les paquets manquants de la liste (après un apt-get update).' },
  ssh_password: { label: 'Connexion SSH par mot de passe', hint: 'PasswordAuthentication autorisé ou interdit (sshd_config.d), vérifié par sshd -t avant rechargement.' },
  root_keys: { label: 'Clés SSH', hint: keysHint },
  root_aliases: { label: 'Alias bash', hint: aliasesHint },
  root_prompt: { label: 'Prompt', hint: promptHint },
  root_motd: { label: "Écran d'accueil", hint: motdHint },
  user: { label: 'Compte', hint: "Créé s'il n'existe pas (shell bash, sans mot de passe), ajouté aux groupes sudo, docker et adm." },
  user_keys: { label: 'Clés SSH', hint: keysHint },
  user_aliases: { label: 'Alias bash', hint: aliasesHint },
  user_prompt: { label: 'Prompt', hint: promptHint },
  user_motd: { label: "Écran d'accueil", hint: motdHint },
};

export const promptLabels = { classic: 'Classique coloré', starship: 'Starship', none: 'Aucun' } as const;
export const motdLabels = { homelab: 'Résumé homelab', fastfetch: 'fastfetch', none: 'Aucun' } as const;

export const isListOption = (k: SetupOption) => k === 'packages' || k === 'root_keys' || k === 'user_keys';

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

// Short description of a value, shown next to "Standard".
export function describeValue<K extends SetupOption>(k: K, v: SetupValues[K]): string {
  switch (k) {
    case 'packages':
      return plural((v as string[]).length, 'paquet');
    case 'root_keys':
    case 'user_keys':
      return plural((v as string[]).length, 'clé');
    case 'ssh_password':
      return v ? 'autorisée' : 'interdite';
    case 'root_aliases':
    case 'user_aliases':
      return plural((v as string).split('\n').filter((l) => l.trim().startsWith('alias')).length, 'alias');
    case 'root_prompt':
    case 'user_prompt':
      return promptLabels[v as keyof typeof promptLabels].toLowerCase();
    case 'root_motd':
    case 'user_motd':
      return motdLabels[v as keyof typeof motdLabels].toLowerCase();
    case 'user': {
      const u = v as SetupValues['user'];
      return `${u.name || '?'}${u.sudoNoPassword ? ', sudo sans mot de passe' : ''}`;
    }
  }
  return '';
}

// Whether the user section applies to a host: its "Compte" option, standard or overridden.
export function hostHasUser(options: SetupOptions, overrides: SetupOverrides) {
  const o = overrides.user;
  return o ? o.mode === 'custom' : options.user.enabled;
}
