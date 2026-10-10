---
title: Standardisation
description: Configuration standard des hôtes (utilisateur, paquets, clés et sécurité SSH, alias, prompt, écran d'accueil), appliquée depuis l'interface et vérifiée en continu
sidebar_position: 3.5
---

# Standardisation

Remplace le script `dispatch_full` de homeSetup : chaque option se pousse d'une case à cocher, sur un hôte ou automatiquement à son ajout, et Homelab Manager signale les hôtes qui s'en écartent.

Disponible sur Debian et Ubuntu (pas sur Unraid), avec un agent à jour.

## Configuration standard

**Paramètres › Standardisation** (administrateurs). Les options cochées forment la configuration standard :

- elles sont pré-cochées sur la fiche de chaque hôte ;
- la conformité de chaque hôte est mesurée par rapport à elles ;
- avec **Appliquer à l'ajout d'un hôte**, un nouvel hôte les reçoit dès sa première connexion. Les hôtes existants ne sont pas touchés.

| Option | Effet sur l'hôte | Conformité |
|---|---|---|
| Utilisateur | créé s'il n'existe pas (bash, sans mot de passe), ajouté aux groupes `sudo`, `docker` et `adm` existants ; option sudo sans mot de passe (`/etc/sudoers.d/90-homelab`, vérifié par `visudo`) | compte, groupes, fichier sudoers |
| Proxy APT | `/etc/apt/apt.conf.d/01proxy` vers un apt-cacher-ng, ou supprimé si vide | contenu du fichier |
| Paquets | `apt-get update` puis installation des paquets manquants de la liste | paquets absents |
| Clés SSH | clés ajoutées à `authorized_keys` de root et de l'utilisateur ; les autres clés sont gardées | clés absentes |
| Config SSH client | `~/.ssh/config` de l'utilisateur | contenu du fichier |
| Alias bash | `~/.bash_aliases` de root et de l'utilisateur | contenu du fichier |
| Prompt | classique coloré (rouge pour root, branche git) ou [Starship](https://starship.rs) | `/etc/homelab/prompt.sh` |
| Écran d'accueil | résumé homelab ou fastfetch | `/etc/homelab/motd.sh` |
| Connexion SSH par mot de passe | `PasswordAuthentication` dans `/etc/ssh/sshd_config.d/00-homelab.conf`, validé par `sshd -t` puis `systemctl reload ssh` | valeur effective (`sshd -T`) |

L'utilisateur se règle dans la configuration standard et peut être changé hôte par hôte. Vide : seul root est configuré.

Les fichiers écrits commencent par une ligne « Géré par Homelab Manager » : une modification locale apparaît comme un écart et sera écrasée à la prochaine application.

### Prompt et écran d'accueil

Ils sont chargés par un bloc ajouté à la fin de `~/.bashrc` de root et de l'utilisateur (entre les marqueurs `# >>> homelab-manager >>>`). Ce bloc charge aussi `~/.bash_aliases` quand `.bashrc` ne le fait pas (le `.bashrc` de root sur Debian).

Le **résumé homelab** remplace fastfetch : il s'affiche instantanément, en bash pur, une fois par connexion.

```text
  pve-docker01 · Debian GNU/Linux 13 (trixie) · lxc
  up 12j 3h 08m  · charge 0.21  · RAM 1.2/4.0 Go  · / 38%
  192.168.100.21  · docker 7/8 conteneurs
  3 mise(s) à jour, dont 1 de sécurité
```

Les mises à jour et les conteneurs viennent de l'agent, qui tient `/etc/homelab/motd.env` à jour.

**Starship** et **fastfetch** s'installent par APT : Debian 13 ou Ubuntu 24.04 et plus récents. Ailleurs, l'option échoue avec un message clair. Starship a besoin d'une police Nerd Font côté terminal pour ses icônes.

### Garde-fous SSH

- L'agent refuse d'interdire le mot de passe tant qu'aucune clé n'est installée pour root ou l'utilisateur.
- La configuration standard refuse « mot de passe interdit » sans l'option **Clés SSH**.
- Si `sshd -t` rejette la configuration, l'ancienne est remise en place.
- `sshd_config` doit inclure `sshd_config.d` (Debian 12, Ubuntu 22.04 et plus récents).

## Sur un hôte

Sur la fiche hôte, l'icône **baguette** de l'en-tête (avec le nombre d'écarts) et la ligne **Standard** du panneau Système (« conforme » ou « 2 écarts ») ouvrent la fenêtre de standardisation.

Elle liste les options, pré-cochées selon la configuration standard, avec leur état : **conforme**, **écart** (avec le détail), **sans objet** (pas de serveur SSH, par exemple). L'utilisateur peut y être changé pour cet hôte.

- **Appliquer la sélection** lance la tâche aussitôt : la fenêtre se ferme et sa console en direct s'affiche sur la fiche, avec son historique. Une option qui échoue n'arrête pas les autres, sauf l'utilisateur.
- **Vérifier** mesure à nouveau la conformité. Elle est aussi vérifiée à chaque connexion de l'agent, après chaque application et après chaque modification de la configuration standard.
- La liste des hôtes affiche un badge **non standard** pour les hôtes en écart.

Rôles : les opérateurs appliquent et vérifient ; seuls les administrateurs modifient la configuration standard. Les lecteurs voient l'état.

## Sécurité

L'agent ne reçoit que des valeurs, jamais de commandes. Il vérifie à nouveau chaque valeur : nom d'utilisateur, noms de paquets, format des clés publiques, adresse du proxy, styles connus. Le contenu des alias et de la config SSH est écrit tel quel dans les fichiers : il est réservé aux administrateurs, comme le reste des paramètres.
