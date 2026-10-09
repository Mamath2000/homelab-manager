---
title: Configuration
description: Variables d'environnement du hub
sidebar_position: 2
---

# Configuration

Le hub se configure par variables d'environnement, lues depuis le fichier `.env` (modèle : `.env.example`) par `docker compose`, `make dev` et `make start`. Une variable vide équivaut à une variable absente.

| Variable | Défaut | Rôle |
|---|---|---|
| `PUBLIC_URL` | adresse utilisée dans le navigateur | URL par laquelle les agents joignent le hub (commande d'installation, script) |
| `CHECK_INTERVAL_HOURS` | `12` | Fréquence de l'`apt-get update` automatique sur les hôtes en ligne ; `0` désactive |
| `HUB_PORT` | `3000` | Port publié par `docker compose` |
| `HUB_IMAGE` | `mathmath350/homelab-manager:latest` | Image utilisée par `docker compose` |
| `MONGO_URL` | `mongodb://localhost:27017/homelab` | Base MongoDB (fixée par `compose.yml` dans Docker) |
| `PORT` | `3000` | Port d'écoute du hub dans le conteneur |
| `SESSION_DAYS` | `30` | Durée des sessions de l'interface |
| `COOKIE_SECURE` | `false` | `true` si le hub est servi en HTTPS |
| `TRUST_PROXY` | `false` | `true` derrière un reverse proxy (en-têtes `X-Forwarded-*`) |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` |
| `TZ` | — | Fuseau horaire des logs |

## Derrière un reverse proxy

Le hub n'a pas besoin d'être exposé, mais il peut passer derrière un reverse proxy local (Nginx Proxy Manager, Traefik…) :

- activer le support **WebSocket** (connexion des agents sur `/agent/ws`) et ne pas bufferiser `/api/events` (flux temps réel) ;
- `TRUST_PROXY=true`, et `COOKIE_SECURE=true` si le proxy sert en HTTPS ;
- `PUBLIC_URL` sur l'URL du proxy si les hôtes peuvent la joindre.

## Données

| Collection MongoDB | Contenu |
|---|---|
| `hosts` | hôtes, hash du token, dernier état système et APT |
| `jobs` | tâches et leurs sorties, supprimées après 90 jours |
| `users`, `sessions` | compte administrateur et sessions |

Sauvegarder le volume `mongo-data` (ou `mongodump`) suffit pour tout restaurer.
