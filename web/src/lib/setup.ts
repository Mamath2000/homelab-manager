import type { Host, SetupModule } from './api';

// Hosts where the standardisation exists, or will once their agent is updated.
export const showSetup = (host: Host) => host.capabilities.includes('setup') || !!host.apt;

// Options of the standardisation, in the order the agent applies them.
export const setupModuleInfo: Record<SetupModule, { label: string; hint: string }> = {
  user: { label: 'Utilisateur', hint: "Créé s'il n'existe pas (shell bash), ajouté aux groupes sudo, docker et adm. Clés SSH, alias, prompt et écran d'accueil s'appliquent à root et à cet utilisateur." },
  packages: { label: 'Paquets', hint: 'Installe les paquets manquants de la liste (après un apt-get update).' },
  ssh_keys: { label: 'Clés SSH', hint: 'Ajoute les clés manquantes à authorized_keys de root et de l’utilisateur ; les autres clés sont gardées.' },
  aliases: { label: 'Alias bash', hint: '~/.bash_aliases de root et de l’utilisateur, chargé par ~/.bashrc.' },
  prompt: { label: 'Prompt', hint: 'Invite de commande : classique colorée (rouge pour root, branche git) ou Starship.' },
  motd: { label: "Écran d'accueil", hint: 'Affiché à la connexion : résumé homelab (instantané) ou fastfetch avec la configuration standard (/etc/homelab/fastfetch.jsonc).' },
  ssh_password: { label: 'Connexion SSH par mot de passe', hint: 'PasswordAuthentication autorisé ou interdit (sshd_config.d), vérifié par sshd -t avant rechargement.' },
};
