---
title: Installation
description: Déployer le hub avec docker compose et installer l'agent sur les hôtes
sidebar_position: 1
---

# Installation

## Le hub

Le hub tourne dans Docker avec sa base MongoDB. Dans un répertoire dédié, récupérer `compose.yml` et `.env.example` depuis le dépôt, puis :

```bash
cp .env.example .env      # optionnel : PUBLIC_URL, CHECK_INTERVAL_HOURS, HUB_PORT…
docker compose up -d
```

```yaml title="compose.yml"
services:
  hub:
    image: ${HUB_IMAGE:-mathmath350/homelab-manager:latest}
    container_name: homelab-manager
    restart: unless-stopped
    ports:
      - "${HUB_PORT:-3000}:3000"
    env_file:
      - path: .env
        required: false
    environment:
      MONGO_URL: mongodb://mongo:27017/homelab
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

Ouvrir ensuite `http://IP_DU_HUB:3000`. Au premier lancement, l'interface demande de créer le compte administrateur (mot de passe de 8 caractères minimum).

:::warning MongoDB et CPU anciens
MongoDB 5 et plus demande un processeur avec les instructions AVX. Sur du matériel ancien (ou une VM sans AVX exposé), utiliser `image: mongo:4.4`.
:::

:::tip URL utilisée par les agents
Par défaut, la commande d'installation des agents reprend l'adresse utilisée dans le navigateur. Si tu ouvres l'interface via un nom ou un reverse proxy que les hôtes ne savent pas joindre, définis `PUBLIC_URL` dans `.env` (voir [Configuration](configuration.md)).
:::

### Mise à jour du hub

```bash
docker compose pull && docker compose up -d
```

Les données (hôtes, historique, compte) sont dans le volume `mongo-data`.

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

### Mettre à jour ou désinstaller l'agent

```bash
# mise à jour (le token existant est conservé)
curl -fsSL http://IP_DU_HUB:3000/install.sh | sh

# désinstallation
curl -fsSL http://IP_DU_HUB:3000/install.sh | sh -s -- --uninstall
```

Supprimer un hôte depuis l'interface révoque son token, mais ne désinstalle pas l'agent : lancer la commande de désinstallation sur l'hôte.
