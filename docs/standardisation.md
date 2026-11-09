---
title: Standardisation
description: Configuration standard des hôtes (paquets, sécurité SSH, puis pour root et un utilisateur clés, alias, prompt, écran d'accueil), surchargeable hôte par hôte, appliquée depuis l'interface et vérifiée en continu
sidebar_position: 3.5
---

# Standardisation

Remplace le script `dispatch_full` de homeSetup. On définit une configuration standard, chaque hôte la suit ou la surcharge option par option, et Homelab Manager signale les hôtes qui s'en écartent.

Disponible sur Debian et Ubuntu (pas sur Unraid), avec un agent à jour.

Désactivée par défaut : il faut `FEATURE_STANDARDISATION=true` sur le hub (voir [Configuration](configuration.md)). Sans la variable, rien n'apparaît dans l'interface, l'API de la standardisation répond 404 et le hub n'applique ni ne vérifie rien, même à la première connexion d'un hôte. Un hôte ajouté pendant que la variable est absente n'est pas standardisé d'office quand on l'active ensuite. Ses valeurs propres et le standard restent en base.

## Trois sections

| Section | Option | Effet sur l'hôte | Conformité |
|---|---|---|---|
| Système | Paquets | `apt-get update` puis installation des paquets manquants de la liste | paquets absents |
| Système | Connexion SSH par mot de passe | `PasswordAuthentication` dans `/etc/ssh/sshd_config.d/00-homelab.conf`, validé par `sshd -t` puis pris en compte par sshd (voir Garde-fous SSH) | valeur effective (`sshd -T`) |
| root, Utilisateur | Clés SSH | clés ajoutées à `~/.ssh/authorized_keys` du compte ; une clé posée par Homelab Manager puis retirée de la configuration est enlevée, les autres clés sont gardées | clés absentes, clés à retirer |
| root, Utilisateur | Alias bash | `~/.host_aliases` du compte ; `~/.bash_aliases` n'est pas touché | contenu du fichier |
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

Les onglets **root** et **Utilisateur** se terminent par **Appliquer les accès aux hôtes** : après une modification enregistrée des clés SSH ou du compte, il les pousse tout de suite sur tous les hôtes qui gèrent ces options (aperçu des hôtes, ceux hors ligne sont ignorés), sans attendre la prochaine application de la standardisation.

## Sur un hôte

Sur la fiche hôte, l'icône **baguette** de l'en-tête (avec le nombre d'écarts) et la ligne **Standard** du panneau Système (« conforme » ou « 2 écarts ») ouvrent la fenêtre de standardisation. On y retrouve les trois sections en onglets verticaux (Système, root, Utilisateur), chacun avec son nombre d'écarts.

Chaque option a son état (**conforme**, **écart** avec le détail, **sans objet**, **non géré**) et un choix :

| Choix | Effet |
|---|---|
| Standard | valeur de la configuration standard, affichée en lecture seule |
| Valeur propre | valeur de cet hôte : mot de passe SSH autorisé ici, autre prompt, autre utilisateur… |
| Standard + ajouts | paquets et clés : la liste standard plus des éléments propres à l'hôte |
| Non géré | l'option n'est ni appliquée ni vérifiée sur cet hôte |

Un hôte créé sur le [réseau d'accès Tailscale](installation.md#réseau-daccès-lan-ou-tailscale) démarre avec **toutes les options en « Non géré »** : rien n'est poussé chez lui (clés SSH, prompt, paquets…) à son premier raccordement, même si l'application automatique est activée. Les options se réactivent une à une sur sa fiche.

« Non géré » sert notamment sur les hôtes où une option n'a pas de sens ou ne peut pas s'appliquer, par exemple Starship ou fastfetch sur Debian 12. Une standardisation groupée remet ces choix au standard (voir ci-dessous).

- **Enregistrer et appliquer** enregistre les choix de l'hôte puis lance la tâche aussitôt (le bouton s'appelle **Appliquer** tant que rien n'est modifié, et il n'est proposé que s'il y a un écart ou une modification : sinon la fenêtre n'offre que **Fermer**) : la fenêtre se ferme et sa console en direct s'affiche sur la fiche, avec son historique. Une option qui échoue n'arrête pas les autres, sauf le compte utilisateur.
- **Vérifier** mesure à nouveau la conformité. Elle est aussi vérifiée à chaque connexion de l'agent, après chaque application et après chaque modification du standard ou des choix de l'hôte.
- La liste des hôtes affiche un badge **non standard** pour les hôtes en écart.

## Sur plusieurs hôtes

Dans **Hôtes**, sélectionner un ou plusieurs hôtes fait apparaître le bouton **Standardisation**. La fenêtre liste les hôtes visés et les options du standard, toutes pré-cochées ; **Appliquer** lance une tâche par hôte.

Les options cochées **repassent au standard** sur chaque hôte : leurs valeurs propres (« Valeur propre », « Standard + ajouts », « Non géré ») sont supprimées, puis le standard est appliqué. La fenêtre liste les valeurs propres qui vont être remplacées. Seules les options du standard sont proposées.

C'est tout ou rien : si un seul hôte devait être refusé (par exemple « mot de passe interdit » sur un hôte qui ne reçoit aucune clé), aucun hôte n'est modifié et le message nomme l'hôte en cause. Les hôtes sans standardisation (Unraid, agent ancien) sont ignorés.

## Prompt et écran d'accueil

Chaque style a son script : `/etc/homelab/prompt/<style>.sh` et `/etc/homelab/motd/<style>.sh`. Un bloc à la fin de `~/.bashrc` de chaque compte (entre les marqueurs `# >>> homelab-manager >>>`) charge ceux de son style. Il charge `~/.bash_aliases` quand le reste de `.bashrc` ne le fait pas (le `.bashrc` de root sur Debian), puis les alias de la standardisation, `~/.host_aliases`, s'il existe : ils passent après et l'emportent en cas de doublon. Le reste de `~/.bashrc` n'est pas modifié, et `~/.bash_aliases` reste à l'utilisateur. Une option « Non géré » garde la ligne déjà présente dans le bloc.

```bash
# >>> homelab-manager >>>
[ -f ~/.bash_aliases ] && . ~/.bash_aliases     # seulement si .bashrc ne le charge pas
[ -f ~/.host_aliases ] && . ~/.host_aliases
[ -r /etc/homelab/prompt/classic.sh ] && . /etc/homelab/prompt/classic.sh
[ -r /etc/homelab/motd/homelab.sh ] && . /etc/homelab/motd/homelab.sh
# <<< homelab-manager <<<
```

Un `~/.bash_aliases` écrit par une version précédente (qui commence par « Géré par Homelab Manager ») est supprimé à l'application des alias ; un fichier écrit à la main n'est jamais touché.

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

## Clés SSH hors configuration

À chaque vérification, l'agent remonte les clés présentes dans `~/.ssh/authorized_keys` de root et de l'utilisateur. Une clé que la configuration (standard ou valeur propre de l'hôte) ne liste pas, et que l'agent n'a pas posée lui-même, est **nouvelle** : l'hôte porte le badge **nouvelle clé SSH** dans la liste des hôtes et dans l'en-tête de sa fiche.

Certaines clés ont une raison d'être (accès propre à un hôte, outil tiers). Dans la fenêtre de standardisation de l'hôte, chaque section (root, Utilisateur) liste ses clés avec leur empreinte et leur commentaire ; sur une clé hors configuration, **Valider** l'acquitte, clé par clé :

- une clé validée ne déclenche plus le badge ; la ligne indique « hors configuration, validée » et **Annuler** remet la clé en nouvelle ;
- la validation est liée à l'**empreinte** de la clé et au compte : une autre clé, même avec le même commentaire, reste nouvelle ;
- elle disparaît dès que la clé quitte l'hôte, ou que la configuration la liste : si la clé revient plus tard, elle est de nouveau signalée ;
- la validation ne change rien sur l'hôte (la clé n'est ni retirée ni approuvée côté SSH), elle n'agit que sur le badge ;
- réservée aux admins, tracée dans le [journal des actions](comptes.md#journal-des-actions).

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

Seuls les administrateurs modifient la configuration standard et les choix d'un hôte, et valident les clés SSH hors configuration : clés SSH, compte, alias et connexion par mot de passe donnent root sur l'hôte. Ces modifications demandent la passkey de nouveau au-delà de 5 minutes ([actions sensibles](comptes.md#actions-sensibles)). Les opérateurs vérifient et appliquent les valeurs enregistrées, et peuvent remettre au standard plusieurs hôtes à la fois, sans rien pouvoir y changer. Les lecteurs voient l'état.

L'agent ne reçoit que des valeurs, jamais de commandes. Il vérifie à nouveau chaque valeur : nom d'utilisateur, noms de paquets, format des clés publiques, styles connus, JSON de fastfetch (le TOML de Starship est vérifié par le hub). Le contenu des alias et des configurations Starship et fastfetch est écrit tel quel dans les fichiers (une commande de fastfetch s'exécute à chaque connexion) : ne donner le profil administrateur qu'à qui peut écrire sur les hôtes.
