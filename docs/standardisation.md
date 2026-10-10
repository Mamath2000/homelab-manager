---
title: Standardisation
description: Configuration standard des hôtes (paquets, sécurité SSH, puis pour root et un utilisateur clés, alias, prompt, écran d'accueil), surchargeable hôte par hôte, appliquée depuis l'interface et vérifiée en continu
sidebar_position: 3.5
---

# Standardisation

Remplace le script `dispatch_full` de homeSetup. On définit une configuration standard, chaque hôte la suit ou la surcharge option par option, et Homelab Manager signale les hôtes qui s'en écartent.

Disponible sur Debian et Ubuntu (pas sur Unraid), avec un agent à jour.

## Trois sections

| Section | Option | Effet sur l'hôte | Conformité |
|---|---|---|---|
| Système | Paquets | `apt-get update` puis installation des paquets manquants de la liste | paquets absents |
| Système | Connexion SSH par mot de passe | `PasswordAuthentication` dans `/etc/ssh/sshd_config.d/00-homelab.conf`, validé par `sshd -t` puis pris en compte par sshd (voir Garde-fous SSH) | valeur effective (`sshd -T`) |
| root, Utilisateur | Clés SSH | clés ajoutées à `~/.ssh/authorized_keys` du compte ; les autres clés sont gardées | clés absentes |
| root, Utilisateur | Alias bash | `~/.bash_aliases` du compte | contenu du fichier |
| root, Utilisateur | Prompt | classique coloré (rouge pour root, branche git) ou [Starship](https://starship.rs) | script du style, paquet, bloc `~/.bashrc` |
| root, Utilisateur | Écran d'accueil | résumé homelab ou fastfetch | script du style, paquet, bloc `~/.bashrc` |
| Utilisateur | Compte | créé s'il n'existe pas (bash, sans mot de passe), ajouté aux groupes `sudo`, `docker` et `adm` existants ; option sudo sans mot de passe (`/etc/sudoers.d/90-homelab`, vérifié par `visudo`) | compte, groupes, fichier sudoers |

- **Système** s'applique à la machine.
- **root** et **Utilisateur** ont chacun leurs propres valeurs : clés, alias, prompt et écran d'accueil peuvent différer entre les deux comptes.
- Les options de l'utilisateur ne s'appliquent que si son **Compte** est géré.

:::warning Aucun compte n'est jamais supprimé

Décocher le compte utilisateur (dans le standard ou sur un hôte) arrête seulement de le gérer : le compte, son dossier personnel et ses fichiers restent sur l'hôte. Homelab Manager ne supprime aucun utilisateur. Changer le nom de l'utilisateur crée le nouveau compte et laisse l'ancien en place. Pour supprimer un compte, c'est à la main sur l'hôte (`userdel`).

:::

Les fichiers écrits commencent par une ligne « Géré par Homelab Manager » : une modification locale apparaît comme un écart et sera écrasée à la prochaine application.

## Configuration standard

**Paramètres › Standardisation** (administrateurs) présente des onglets verticaux : **Général** (application à l'ajout d'un hôte), puis un onglet par section avec le nombre d'options cochées, et les configurations Starship et fastfetch quand elles servent. Une option cochée fait partie du standard :

- elle s'applique aux hôtes qui ne la surchargent pas ;
- la conformité est mesurée par rapport à elle ;
- avec **Appliquer à l'ajout d'un hôte**, un nouvel hôte reçoit le standard dès sa première connexion. Les hôtes existants ne sont pas touchés.

Deux onglets de configuration, communs à root et à l'utilisateur, apparaissent quand leur style est utilisé :

- **Configuration Starship** (prompt Starship) : TOML écrit dans `/etc/homelab/starship.toml`, vérifié à l'enregistrement ;
- **Configuration fastfetch** (écran d'accueil fastfetch) : JSON écrit dans `/etc/homelab/fastfetch.jsonc`.

## Sur un hôte

Sur la fiche hôte, l'icône **baguette** de l'en-tête (avec le nombre d'écarts) et la ligne **Standard** du panneau Système (« conforme » ou « 2 écarts ») ouvrent la fenêtre de standardisation. On y retrouve les trois sections en onglets verticaux (Système, root, Utilisateur), chacun avec son nombre d'écarts.

Chaque option a son état (**conforme**, **écart** avec le détail, **sans objet**, **non géré**) et un choix :

| Choix | Effet |
|---|---|
| Standard | valeur de la configuration standard, affichée en lecture seule |
| Valeur propre | valeur de cet hôte : mot de passe SSH autorisé ici, autre prompt, autre utilisateur… |
| Standard + ajouts | paquets et clés : la liste standard plus des éléments propres à l'hôte |
| Non géré | l'option n'est ni appliquée ni vérifiée sur cet hôte |

« Non géré » sert notamment sur les hôtes où une option n'a pas de sens ou ne peut pas s'appliquer, par exemple Starship ou fastfetch sur Debian 12. Une standardisation groupée remet ces choix au standard (voir ci-dessous).

- **Enregistrer** garde les choix de l'hôte et relance la vérification.
- **Enregistrer et appliquer** (ou **Appliquer**) lance la tâche aussitôt : la fenêtre se ferme et sa console en direct s'affiche sur la fiche, avec son historique. Une option qui échoue n'arrête pas les autres, sauf le compte utilisateur.
- **Vérifier** mesure à nouveau la conformité. Elle est aussi vérifiée à chaque connexion de l'agent, après chaque application et après chaque modification du standard ou des choix de l'hôte.
- La liste des hôtes affiche un badge **non standard** pour les hôtes en écart.

## Sur plusieurs hôtes

Dans **Hôtes**, sélectionner un ou plusieurs hôtes fait apparaître le bouton **Standardisation**. La fenêtre liste les hôtes visés et les options du standard, toutes pré-cochées ; **Appliquer** lance une tâche par hôte.

Les options cochées **repassent au standard** sur chaque hôte : leurs valeurs propres (« Valeur propre », « Standard + ajouts », « Non géré ») sont supprimées, puis le standard est appliqué. La fenêtre liste les valeurs propres qui vont être remplacées. Seules les options du standard sont proposées.

C'est tout ou rien : si un seul hôte devait être refusé (par exemple « mot de passe interdit » sur un hôte qui ne reçoit aucune clé), aucun hôte n'est modifié et le message nomme l'hôte en cause. Les hôtes sans standardisation (Unraid, agent ancien) sont ignorés.

## Prompt et écran d'accueil

Chaque style a son script : `/etc/homelab/prompt/<style>.sh` et `/etc/homelab/motd/<style>.sh`. Un bloc à la fin de `~/.bashrc` de chaque compte (entre les marqueurs `# >>> homelab-manager >>>`) charge ceux de son style. Il charge aussi `~/.bash_aliases` quand `.bashrc` ne le fait pas (le `.bashrc` de root sur Debian). Une option « Non géré » garde la ligne déjà présente dans le bloc.

Le **résumé homelab** s'affiche instantanément, en bash pur, une fois par connexion.

```text
  pve-docker01 · Debian GNU/Linux 13 (trixie) · lxc
  up 12j 3h 08m  · charge 0.21  · RAM 1.2/4.0 Go  · / 38%
  192.168.100.21  · docker 7/8 conteneurs
  3 mise(s) à jour, dont 1 de sécurité
```

Les mises à jour et les conteneurs viennent de l'agent, qui tient `/etc/homelab/motd.env` à jour.

**Starship** lit `/etc/homelab/starship.toml` (`STARSHIP_CONFIG`) : un `~/.config/starship.toml` présent sur l'hôte est ignoré, sans être supprimé. La configuration par défaut affiche `utilisateur@hôte:` puis le dossier sur la ligne suivante. Les modules `username` et `hostname` y ont leur propre `format`, car celui de Starship ajoute « in » après chacun.

**fastfetch** se lance avec `/etc/homelab/fastfetch.jsonc`. La configuration par défaut est générique : la ligne Klipper n'apparaît que si le service existe (une commande qui échoue ou n'affiche rien masque sa ligne), l'adresse affichée est celle de l'interface de la route par défaut, `/boot/firmware` n'apparaît que sur un Raspberry Pi.

**Starship** et **fastfetch** s'installent par APT : Debian 13 ou Ubuntu 24.04 et plus récents. Ni Debian 12 ni ses backports ne les ont : l'option y échoue avec un message clair, la mettre en « Non géré » sur ces hôtes. Starship a besoin d'une police Nerd Font côté terminal pour ses icônes.

## Garde-fous SSH

- L'agent refuse d'interdire le mot de passe tant qu'aucune clé n'est installée pour root ou l'utilisateur.
- Le standard comme les choix d'un hôte refusent « mot de passe interdit » sans clés SSH poussées pour root ou l'utilisateur.
- Si `sshd -t` rejette la configuration, l'ancienne est remise en place.
- `sshd_config` doit inclure `sshd_config.d` (Debian 12, Ubuntu 22.04 et plus récents).
- Prise en compte de la nouvelle configuration :
  - sshd en écoute directe : `systemctl reload ssh` ;
  - socket activation (`ssh.socket` actif, cas des LXC Proxmox) : `systemctl restart ssh.service`. Un reload y tue sshd, car le port 22 est tenu par systemd. Le restart garde les sessions ouvertes et systemd rend le socket à sshd ;
  - service arrêté : rien à faire, la configuration est lue au prochain démarrage ou à la prochaine connexion.
- `/run/sshd` est créé s'il manque (service arrêté), sinon `sshd -t` et `sshd -T` échouent.

## Rôles et sécurité

Les opérateurs règlent les choix d'un hôte, appliquent et vérifient ; seuls les administrateurs modifient la configuration standard. Les lecteurs voient l'état.

L'agent ne reçoit que des valeurs, jamais de commandes. Il vérifie à nouveau chaque valeur : nom d'utilisateur, noms de paquets, format des clés publiques, styles connus, JSON de fastfetch (le TOML de Starship est vérifié par le hub). Le contenu des alias et des configurations Starship et fastfetch est écrit tel quel dans les fichiers (une commande de fastfetch s'exécute à chaque connexion) : ne donner le rôle administrateur qu'à qui peut écrire sur les hôtes.
