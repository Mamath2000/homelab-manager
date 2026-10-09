---
title: Configuration
description: Paramètres de l'application et variables d'environnement du hub
sidebar_position: 2
---

# Configuration

## Paramètres de l'application

Réglés dans l'interface, **Paramètres > Agent**, et stockés en base :

| Paramètre | Défaut | Rôle |
|---|---|---|
| URL du hub (agents) | adresse utilisée dans le navigateur | URL par laquelle les hôtes joignent le hub : commande d'installation, script `install.sh`, liens « configuration » dans Home Assistant |
| Vérification automatique des mises à jour | `12` h | Fréquence de l'`apt-get update` lancé sur les hôtes en ligne ; `0` désactive |
| Mise à jour automatique des agents | activée | Un agent d'une autre version que celle du hub se met à jour seul |

## Variables d'environnement

Fixées dans `compose.yml` pour le déploiement, et par le Makefile en local (`make start PORT=4000 LOG=debug MONGO_URL=…`). Une variable vide équivaut à une variable absente.

| Variable | Défaut | Rôle |
|---|---|---|
| `MONGO_URL` | `mongodb://localhost:27017/homelab` | Base MongoDB (`mongodb://mongo:27017/homelab` dans `compose.yml`) |
| `PORT` | `3000` | Port d'écoute du hub ; en Docker le port publié se choisit dans `ports:` |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` (`LOG=` avec le Makefile) |
| `SESSION_DAYS` | `30` | Durée des sessions de l'interface |
| `COOKIE_SECURE` | `false` | `true` si le hub est servi en HTTPS |
| `TRUST_PROXY` | `false` | `true` derrière un reverse proxy (en-têtes `X-Forwarded-*`) |

## Derrière un reverse proxy

Le hub n'a pas besoin d'être exposé, mais il peut passer derrière un reverse proxy local (Nginx Proxy Manager, Traefik…) :

- activer le support **WebSocket** (connexion des agents sur `/agent/ws`) et ne pas bufferiser `/api/events` (flux temps réel) ;
- `TRUST_PROXY=true`, et `COOKIE_SECURE=true` si le proxy sert en HTTPS ;
- **URL du hub (agents)** sur l'URL du proxy si les hôtes peuvent la joindre.

## Données

| Collection MongoDB | Contenu |
|---|---|
| `settings` | paramètres de l'application (agents, Home Assistant) |
| `hosts` | hôtes, hash du token, dernier état système et APT |
| `jobs` | tâches et leurs sorties, supprimées après 90 jours |
| `users`, `sessions` | comptes utilisateurs et sessions |

Sauvegarder le volume `mongo-data` (ou `mongodump`) suffit pour tout restaurer.
