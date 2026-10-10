import type { SetupModule } from './api';

// Options of the standardisation, in the order the agent applies them.
export const setupModuleInfo: Record<SetupModule, { label: string; hint: string }> = {
  user: { label: 'Utilisateur', hint: "Créé s'il n'existe pas (shell bash), ajouté aux groupes sudo, docker et adm." },
  apt_proxy: { label: 'Proxy APT', hint: 'Cache apt-cacher-ng dans /etc/apt/apt.conf.d/01proxy, ou aucun (fichier supprimé).' },
  packages: { label: 'Paquets', hint: 'Installe les paquets manquants de la liste (après un apt-get update).' },
  ssh_keys: { label: 'Clés SSH', hint: 'Ajoute les clés manquantes à authorized_keys de root et de l’utilisateur ; les autres clés sont gardées.' },
  ssh_config: { label: 'Config SSH client', hint: '~/.ssh/config de l’utilisateur (raccourcis vers les autres hôtes).' },
  aliases: { label: 'Alias bash', hint: '~/.bash_aliases de root et de l’utilisateur, chargé par ~/.bashrc.' },
  prompt: { label: 'Prompt', hint: 'Invite de commande : classique colorée (rouge pour root, branche git) ou Starship.' },
  motd: { label: "Écran d'accueil", hint: 'Affiché à la connexion : résumé homelab (instantané) ou fastfetch.' },
  ssh_password: { label: 'Connexion SSH par mot de passe', hint: 'PasswordAuthentication autorisé ou interdit (sshd_config.d), vérifié par sshd -t avant rechargement.' },
};
