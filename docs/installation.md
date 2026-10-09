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
      - "3000:3000"           # <port publié>:3000
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

:::tip URL utilisée par les agents
Par défaut, la commande d'installation des agents reprend l'adresse utilisée dans le navigateur. Si tu ouvres l'interface via un nom ou un reverse proxy que les hôtes ne savent pas joindre, renseigne **URL du hub (agents)** dans **Paramètres > Agent** (voir [Configuration](configuration.md)).
:::

### Mise à jour du hub

```bash
docker compose pull && docker compose up -d
```

Les données (hôtes, historique, comptes) sont dans le volume `mongo-data`.

## Les agents

### Prérequis

- Debian ou Ubuntu (APT), avec systemd ;
- `curl` ou `wget` ;
- accès root ;
- accès réseau de l'hôte vers le hub (port 3000 par défaut). Rien n'est à ouvrir sur l'hôte.

### Ajouter un hôte

1. Dans l'interface : **Ajouter un hôte**, saisir un nom et éventuellement un groupe (`infra`, `media`, `domotique`…).
2. Copier la commande affichée et la lancer **en root** sur l'hôte :

```bash
curl -fsSL http://IP_DU_HUB:3000/install.sh | sh -s -- TOKEN
```

L'hôte passe « En ligne » quelques secondes plus tard et remonte son état.

:::info Token
Le token n'est affiché qu'une seule fois. S'il est perdu, la fiche de l'hôte permet d'en générer un nouveau (l'ancien est alors révoqué et l'agent déconnecté).
:::

### Ce que l'installation met en place

| Élément | Emplacement |
|---|---|
| Binaire de l'agent (amd64 ou arm64) | `/usr/local/bin/homelab-agent` |
| Configuration (URL du hub, token), droits 600 | `/etc/homelab-agent.env` |
| Service systemd | `homelab-agent.service` |

```bash
systemctl status homelab-agent
journalctl -u homelab-agent -f
```

### Mise à jour des agents

Le hub distribue les binaires de l'agent livrés avec son image : mettre à jour le hub suffit.

- Chaque agent envoie au hub l'empreinte SHA-256 de son binaire ; s'il diffère de celui du hub pour son architecture, l'agent est signalé **« Agent à mettre à jour »** (cartes et liste des hôtes, fiche de l'hôte, tâche dans le bloc Activité du tableau de bord, Home Assistant).
- Avec **Paramètres → Agent → Mettre à jour les agents automatiquement** (activé par défaut), le hub lance la mise à jour dès qu'un agent obsolète se connecte. Sinon, un bouton « Mettre à jour » est proposé.
- L'agent télécharge le nouveau binaire depuis le hub, vérifie son empreinte, remplace `/usr/local/bin/homelab-agent` puis s'arrête : systemd le relance aussitôt avec la nouvelle version. En cas d'échec, un nouvel essai automatique a lieu au plus une fois par heure.
- L'en-tête de l'interface affiche la version du hub et celle de l'agent qu'il distribue. L'agent a sa propre version (X.Y.Z), indépendante de celle du hub.
- Après un redémarrage du hub, les agents se reconnectent seuls en quelques secondes : délai de 1 s augmenté de 20 % à chaque échec, plafonné à 30 s, avec un aléa de ±20 %.

:::warning Agents installés avant la mise à jour automatique
Les agents de la toute première version ne savent pas se mettre à jour seuls : ils sont signalés comme les autres, mais doivent être réinstallés **une fois** avec la commande ci-dessous. Ensuite, tout est automatique.
:::

### Mettre à jour manuellement ou désinstaller l'agent

```bash
# mise à jour manuelle (le token existant est conservé)
curl -fsSL http://IP_DU_HUB:3000/install.sh | sh

# désinstallation
curl -fsSL http://IP_DU_HUB:3000/install.sh | sh -s -- --uninstall
```

Supprimer un hôte depuis l'interface révoque son token, mais ne désinstalle pas l'agent : lancer la commande de désinstallation sur l'hôte.
