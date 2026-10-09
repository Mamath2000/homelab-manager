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
| URL du hub | adresse utilisée dans le navigateur | Adresse de l'interface telle que les hôtes la joignent : liens « configuration » dans Home Assistant ; son nom d'hôte sert aussi aux agents |
| Port TLS des agents | `3443` (`AGENT_TLS_PORT`) | Port **publié** du hub pour les agents. Les agents se connectent à `https://<nom d'hôte de l'URL du hub>:<port>`. Un agent garde l'adresse de son installation : après un changement, relancer la commande de mise à jour sur l'hôte |
| Vérification automatique des mises à jour | `12` h | Fréquence de l'`apt-get update` lancé sur les hôtes en ligne ; `0` désactive |
| Mise à jour automatique des agents | activée | Un agent d'une autre version que celle du hub se met à jour seul |

### Adresse des agents

Dans **URL du hub**, saisir l'adresse de l'interface telle que les hôtes la joignent, en `http://` ou en `https://` : peu importe pour les agents. Le hub n'en garde que le **nom d'hôte** et donne aux agents `https://<nom d'hôte>:<Port TLS des agents>`. Le protocole et le port saisis ne servent qu'aux liens de Home Assistant.

| URL du hub saisie | Adresse donnée aux agents |
|---|---|
| `http://192.168.1.10:3000` | `https://192.168.1.10:3443` |
| `https://hm.lan` (reverse proxy) | `https://hm.lan:3443` |
| vide | nom d'hôte utilisé dans le navigateur, port `3443` |

- Le nom d'hôte doit mener à la machine où le port des agents du hub est publié. Si `hm.lan` pointe vers un reverse proxy installé sur une autre machine, saisir plutôt l'IP du hub (`http://192.168.1.10:3000`), ou faire passer le port `3443` par le proxy en TCP, sans terminaison TLS (voir [Derrière un reverse proxy](#derrière-un-reverse-proxy)).
- Pour vérifier : la ligne **Adresse des agents** de **Paramètres > Agent** affiche l'adresse exacte utilisée dans les commandes d'installation.
- Un agent garde l'adresse de son installation : après un changement, relancer sur l'hôte la commande de mise à jour manuelle (**Paramètres > Agent**).

## Variables d'environnement

Fixées dans `compose.yml` pour le déploiement, et par le Makefile en local (`make start PORT=4000 LOG=debug MONGO_URL=…`). Une variable vide équivaut à une variable absente.

| Variable | Défaut | Rôle |
|---|---|---|
| `MONGO_URL` | `mongodb://localhost:27017/homelab` | Base MongoDB (`mongodb://mongo:27017/homelab` dans `compose.yml`) |
| `PORT` | `3000` | Port d'écoute de l'interface et de l'API ; en Docker le port publié se choisit dans `ports:` |
| `AGENT_TLS_PORT` | `3443` | Port d'écoute TLS des agents (script d'installation, binaires, enrôlement, WebSocket) |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` (`LOG=` avec le Makefile) |
| `SESSION_DAYS` | `30` | Durée des sessions de l'interface |
| `COOKIE_SECURE` | `false` | `true` si le hub est servi en HTTPS |
| `TRUST_PROXY` | `false` | `true` derrière un reverse proxy (en-têtes `X-Forwarded-*`) |

## Derrière un reverse proxy

Le hub n'a pas besoin d'être exposé, mais il peut passer derrière un reverse proxy local (Nginx Proxy Manager, Traefik…) :

- ne pas bufferiser `/api/events` (flux temps réel) ;
- `TRUST_PROXY=true`, et `COOKIE_SECURE=true` si le proxy sert en HTTPS ;
- le port des agents (`3443`) ne passe **pas** par un reverse proxy qui termine le TLS : il casserait l'épinglage et l'authentification des agents par certificat. Le publier directement, ou via un proxy TCP (*passthrough*) ;
- **URL du hub** : son nom d'hôte doit mener à la machine où le port des agents est publié.

## Données

| Collection MongoDB | Contenu |
|---|---|
| `settings` | paramètres de l'application (agents, Home Assistant) et autorité de certification du hub (document `pki`, clés privées comprises) |
| `hosts` | hôtes, empreinte du certificat de l'agent, hash du code d'installation en attente, dernier état système et APT |
| `jobs` | tâches et leurs sorties, supprimées après 90 jours |
| `users`, `sessions` | comptes utilisateurs et sessions |

Sauvegarder le volume `mongo-data` (ou `mongodump`) suffit pour tout restaurer, y compris l'autorité de certification : les agents se reconnectent sans réinstallation. La sauvegarde contient les clés privées du hub, elle est à protéger comme un secret.
