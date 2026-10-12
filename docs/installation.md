---
title: Installation
description: Déployer le hub avec docker compose et installer l'agent sur les hôtes
sidebar_position: 1
---

# Installation

## Le hub

Le hub tourne dans Docker avec sa base MongoDB. Dans un répertoire dédié, récupérer `compose.yml` depuis le dépôt, l'ajuster si besoin (port publié, niveau de logs, reverse proxy), puis :

```bash
docker compose up -d
```

```yaml title="compose.yml"
services:
  hub:
    image: mathmath350/homelab-manager:latest
    container_name: homelab-manager
    restart: unless-stopped
    ports:
      - "3000:3000"           # interface et API : <port publié>:3000
      - "3443:3443"           # agents, en TLS : <port publié>:3443 (à reporter dans Paramètres > Agent s'il diffère)
    environment:
      MONGO_URL: mongodb://mongo:27017/homelab
      LOG_LEVEL: info         # fatal | error | warn | info | debug
      TZ: Europe/Paris        # fuseau du hub : fuseau par défaut des sauvegardes de répertoires
      # SESSION_DAYS: 30
      # TRUST_PROXY: "true"   # derrière un reverse proxy (en-têtes X-Forwarded-*)
      # COOKIE_SECURE: "true" # si le hub est servi en HTTPS
    depends_on:
      - mongo

  mongo:
    image: mongo:7
    container_name: homelab-manager-mongo
    restart: unless-stopped
    volumes:
      - ./mongo-data:/data/db           # dossier local : survit à « docker compose down -v »
      - ./mongo-config:/data/configdb
```

### Premier démarrage

Sur une base vide, le hub écrit dans ses logs le mot de passe **à usage unique** du compte `superadmin` :

```bash
docker compose logs hub
```

```text
  Homelab Manager : premier démarrage, aucun compte
  Connexion :      superadmin
  Mot de passe :   ZWFQ8CSOh3hAn28V
```

1. Ouvrir `http://IP_DU_HUB:3000` et se connecter en `superadmin` avec ce mot de passe.
2. Page **Comptes** : créer son compte `admin` (et les autres). Un mot de passe temporaire s'affiche une seule fois.
3. Se déconnecter, se connecter avec son compte et le mot de passe temporaire : l'interface demande d'en choisir un (8 caractères minimum).

Le mot de passe `superadmin` est valable 24 h. Perdu ou expiré : redémarrer le hub (`docker compose restart hub`) en génère un nouveau, tant qu'aucun compte n'existe. Voir [Comptes et rôles](comptes.md).

:::warning MongoDB et CPU anciens
MongoDB 5 et plus demande un processeur avec les instructions AVX. Sur du matériel ancien (ou une VM sans AVX exposé), utiliser `image: mongo:4.4`.
:::

:::tip Adresse utilisée par les agents
Les agents joignent le hub en TLS sur le port `3443`, avec le nom d'hôte de l'adresse utilisée dans le navigateur. Si tu ouvres l'interface via un nom ou un reverse proxy que les hôtes ne savent pas joindre, renseigne **URL du hub** dans **Paramètres > Agent**, en `http://` ou `https://` (peu importe : seul son nom d'hôte sert aux agents). Si tu publies le port des agents sur un autre numéro, reporte-le dans **Port TLS des agents**. Détails et exemples : [Adresse des agents](configuration.md#adresse-des-agents).
:::

### Mise à jour du hub

```bash
docker compose pull && docker compose up -d
```

Les données (hôtes, historique, comptes) sont dans le dossier `mongo-data/`, à côté du `compose.yml` (montage local plutôt qu'un volume Docker : un `docker compose down -v` ou un `docker volume prune` ne les supprime pas). Sauvegarde : voir [Données](configuration.md#données).

## Les agents

### Prérequis

- Debian ou Ubuntu (APT) avec systemd, y compris sous **WSL2**, **Unraid** ou **Home Assistant OS** (voir plus bas) ;
- `curl` (`apt install curl`) : il vérifie la clé du hub pendant l'installation, ce que wget ne sait pas faire ;
- accès root ;
- accès réseau de l'hôte vers le hub sur le port des agents (`3443` par défaut). Rien n'est à ouvrir sur l'hôte.

### Ajouter un hôte

1. Dans l'interface : **Ajouter un hôte**, saisir un nom et éventuellement un groupe (`infra`, `media`, `domotique`…).
2. Copier la commande affichée et la lancer **en root** sur l'hôte :

```bash
curl -fsSLk --pinnedpubkey sha256//CLÉ_DU_HUB https://IP_DU_HUB:3443/install.sh | sh -s -- CODE
```

L'agent génère sa clé privée sur l'hôte, reçoit un certificat du hub, puis passe « En ligne » quelques secondes plus tard et remonte son état.

:::info Commande d'installation
- `--pinnedpubkey` épingle la clé du hub : la commande échoue si un autre serveur répond à sa place.
- `CODE` est **à usage unique et valable 24 h**. La commande n'est affichée qu'une fois ; au besoin, **Nouvelle commande d'installation** (icône clé sur la fiche de l'hôte) en génère une autre et annule la précédente.

Détails dans [Sécurité](securite.md).
:::

### Ce que l'installation met en place

| Élément | Emplacement |
|---|---|
| Binaire de l'agent (amd64 ou arm64) | `/usr/local/bin/homelab-agent` |
| Configuration (adresse du hub), droits 600 | `/etc/homelab-agent/agent.env` |
| Certificat de l'autorité du hub | `/etc/homelab-agent/ca.pem` |
| Clé privée de l'agent (droits 600) et son certificat | `/etc/homelab-agent/agent.key`, `/etc/homelab-agent/agent.crt` |
| État (stacks Docker connues) | `/var/lib/homelab-agent/` |
| Service systemd | `homelab-agent.service` |

```bash
systemctl status homelab-agent
journalctl -u homelab-agent -f
```

### Installer dans un autre répertoire

Pour tout regrouper ailleurs, renseigne **Répertoire d'installation** dans la fenêtre d'installation, ou ajoute `--dir` à la commande :

```bash
curl -fsSLk --pinnedpubkey sha256//CLÉ_DU_HUB https://IP_DU_HUB:3443/install.sh | sh -s -- CODE --dir /opt/homelab-agent
```

Binaire, configuration, certificat, clé et état (`state/`) vont alors dans ce répertoire, et le service systemd pointe dessus. Le chemin doit être absolu, sans espace : lettres, chiffres, `.`, `_`, `-`, `/`.

- La mise à jour manuelle et la désinstallation retrouvent seules le répertoire, grâce au service systemd : les commandes de **Paramètres > Agent** ne changent pas.
- Relancer la commande avec un autre `--dir` **déplace** l'installation : l'identité de l'agent suit (pas besoin de nouveau code) et l'ancien emplacement est nettoyé.

### Unraid

Unraid n'a ni systemd ni APT, et son système tourne en mémoire : tout ce qui n'est pas sur la clé USB (`/boot`) ou les disques disparaît au redémarrage. La même commande d'installation fonctionne ; le script détecte Unraid et :

- garde les fichiers de l'agent (binaire, configuration, certificat, clé, stacks connues) dans `/boot/config/plugins/homelab-agent`, ou dans le répertoire donné par `--dir` (un partage sur les disques par exemple) ;
- ajoute une ligne au script de démarrage `/boot/config/go` ;
- au démarrage d'Unraid, cette ligne copie le binaire dans `/usr/local/bin` et lance l'agent, qui est relancé automatiquement s'il s'arrête (après une mise à jour, par exemple). Logs dans `/var/log/homelab-agent.log`.

Sur Unraid, l'hôte remonte son état système et ses **stacks Docker** (voir [Docker](docker.md)). Il n'a pas de mises à jour APT (colonne des mises à jour « non pris en charge », en gris, dans la liste des hôtes) ni de bouton Redémarrer : un redémarrage d'Unraid passe par son interface, qui arrête proprement l'array. La mise à jour automatique de l'agent met aussi à jour la copie gardée sur la clé USB.

### Home Assistant OS

HAOS est une appliance : on n'y lance pas de script. L'agent s'installe comme **application** (add-on) Home Assistant, publiée dans le repo [homelab-manager-haos](https://github.com/Mamath2000/homelab-manager-haos). Elle embarque le binaire de l'agent livré par le hub et tourne sur le réseau de l'hôte : l'agent voit l'interface réelle de la VM, donc sa MAC, et les sauvegardes Proxmox VE de la VM se rattachent à l'hôte (voir [Sauvegardes](sauvegardes.md#lien-hôte--guest-proxmox)).

1. Dans Homelab Manager : **Ajouter un hôte**, puis l'onglet **Home Assistant OS** de la fenêtre d'installation, qui affiche un **jeton d'installation** (adresse du hub, clé épinglée et code à usage unique, valable 24 h).
2. Dans Home Assistant : **Paramètres › Applications › Boutique › ⋮ › Dépôts**, ajouter `https://github.com/Mamath2000/homelab-manager-haos`.
3. Installer **Homelab Manager Agent**, coller le jeton dans l'option `install_token` de l'onglet Configuration, puis démarrer l'application.
4. Activer **Mise à jour automatique** sur l'application.

Au premier démarrage, l'application récupère l'autorité du hub (clé vérifiée par le jeton) et enrôle l'agent ; certificat et clé restent dans les données de l'application. Coller un nouveau jeton réenrôle l'agent. Les erreurs (jeton illisible, hub injoignable, code expiré) sont dans le **Journal** de l'application.

Ce que remonte un hôte HAOS :

- **système** : version de Home Assistant OS, nom d'hôte et virtualisation lus par l'API Supervisor, adresses et MAC de la VM (les interfaces internes de HA et Docker sont ignorées) ;
- **rien d'autre** : ni mises à jour APT (« non pris en charge » dans la liste des hôtes), ni stacks Docker, ni standardisation, ni bouton Redémarrer, ni sauvegardes de répertoires (HA sauvegarde déjà ses fichiers).

**Mises à jour.** L'agent ne se met pas à jour lui-même : un binaire remplacé dans le conteneur serait perdu à sa recréation. La version de l'application suit celle de l'agent : à chaque release du hub, une tâche GitHub Actions du repo (lancée par `make docker-release`, et chaque jour) publie une nouvelle version de l'application si l'agent a changé, que Home Assistant installe seul avec la mise à jour automatique. Un agent HAOS en retard est signalé sans bouton de mise à jour.

**Désinstallation.** Désinstaller l'application dans Home Assistant, puis supprimer l'hôte dans Homelab Manager.

### WSL2 (Windows)

Une distribution Debian ou Ubuntu sous WSL2 s'installe comme un hôte Debian, avec systemd activé. L'image Debian de WSL ne l'active pas et n'a pas `curl` ; le script s'occupe de systemd :

1. Dans la distribution, en root : `apt update && apt install -y curl` ;
2. Lancer la commande d'installation. Si systemd ne tourne pas, le script ajoute `systemd=true` à la section `[boot]` de `/etc/wsl.conf` (le reste du fichier est conservé) et s'arrête ;
3. Depuis Windows : `wsl --shutdown`, puis rouvrir la distribution ;
4. Relancer **la même commande** : l'agent s'installe en service systemd et passe « En ligne ».

Particularités :

- **Pas de bouton Redémarrer** : un `reboot` arrête la distribution, qui ne redémarre que depuis Windows (`wsl --shutdown` / `wsl -t <distribution>` puis réouverture) ;
- **Pas de Docker** : l'agent ignore Docker sous WSL (même si Docker Desktop y expose son socket). L'hôte remonte son état système, ses mises à jour APT et la standardisation ;
- le système affiché porte la mention « (WSL) », et l'hôte remonte l'IP interne de WSL (le réseau NAT n'empêche rien : c'est l'agent qui se connecte au hub sur le port des agents) ;
- **l'hôte n'est en ligne que quand WSL tourne.** WSL ne démarre pas avec Windows et peut s'arrêter quand plus aucun terminal n'est ouvert. Pour le garder actif pendant la session Windows, créer une tâche planifiée « À l'ouverture de session » qui lance `wsl.exe -d Debian -u root --exec sleep infinity` (nom exact de la distribution : `wsl -l -v`).

### Mise à jour des agents

Le hub distribue les binaires de l'agent livrés avec son image : mettre à jour le hub suffit.

- Chaque agent envoie au hub l'empreinte SHA-256 de son binaire ; s'il diffère de celui du hub pour son architecture, l'agent est signalé **« Agent à mettre à jour »** (cartes et liste des hôtes, fiche de l'hôte, tâche dans le bloc Activité du tableau de bord, Home Assistant).
- Avec **Paramètres → Agent → Mettre à jour les agents automatiquement** (activé par défaut), le hub lance la mise à jour dès qu'un agent obsolète se connecte. Sinon, un bouton « Mettre à jour » est proposé.
- L'agent télécharge le nouveau binaire depuis le hub, vérifie son empreinte et sa signature (agents de release, voir [Sécurité](securite.md)), remplace `/usr/local/bin/homelab-agent` puis s'arrête : systemd le relance aussitôt avec la nouvelle version. En cas d'échec, un nouvel essai automatique a lieu au plus une fois par heure.
- L'en-tête de l'interface affiche la version du hub et celle de l'agent qu'il distribue. L'agent a sa propre version (X.Y.Z), indépendante de celle du hub.
- Après un redémarrage du hub, les agents se reconnectent seuls en quelques secondes : délai de 1 s augmenté de 20 % à chaque échec, plafonné à 30 s, avec un aléa de ±20 %.

### Agents installés avant la connexion TLS

Les premiers agents se connectaient en clair avec un jeton, sur le port 3000. Le hub les refuse désormais : ils apparaissent hors ligne avec le badge **« Réinstallation requise »** (carte « Agents à réinstaller » du tableau de bord, filtre « À réinstaller » de la page Hôtes).

Pour chacun, une seule fois : sur la fiche de l'hôte, **Commande d'installation**, puis lancer la commande en root sur l'hôte. L'hôte garde son historique ; l'installation remplace l'ancienne configuration (`/etc/homelab-agent.env` est supprimé). L'ancienne commande de mise à jour (`http://…:3000/install.sh`) échoue avec un message qui renvoie vers l'interface.

### Mettre à jour manuellement ou désinstaller l'agent

Les deux commandes, avec la clé du hub, sont dans **Paramètres > Agent** :

```bash
# mise à jour manuelle (le certificat de l'agent est conservé)
curl -fsSLk --pinnedpubkey sha256//CLÉ_DU_HUB https://IP_DU_HUB:3443/install.sh | sh

# désinstallation
curl -fsSLk --pinnedpubkey sha256//CLÉ_DU_HUB https://IP_DU_HUB:3443/install.sh | sh -s -- --uninstall
```

**Révoquer l'agent** (fiche de l'hôte) le déconnecte et refuse son certificat ; supprimer l'hôte fait de même. Aucun des deux ne désinstalle l'agent : lancer la commande de désinstallation sur l'hôte.
