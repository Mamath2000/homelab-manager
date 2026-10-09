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
      - mongo-data:/data/db

volumes:
  mongo-data:
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
Les agents joignent le hub en TLS sur le port `3443`, avec le nom d'hôte de l'adresse utilisée dans le navigateur. Si tu ouvres l'interface via un nom ou un reverse proxy que les hôtes ne savent pas joindre, renseigne **URL du hub** dans **Paramètres > Agent**. Si tu publies le port des agents sur un autre numéro, reporte-le dans **Port TLS des agents** (voir [Configuration](configuration.md)).
:::

### Mise à jour du hub

```bash
docker compose pull && docker compose up -d
```

Les données (hôtes, historique, comptes) sont dans le volume `mongo-data`.

## Les agents

### Prérequis

- Debian ou Ubuntu (APT), avec systemd ;
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
| Service systemd | `homelab-agent.service` |

```bash
systemctl status homelab-agent
journalctl -u homelab-agent -f
```

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
