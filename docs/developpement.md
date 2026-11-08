---
title: Développement et architecture
description: Architecture du hub et des agents, API REST, lancement local, release et feuille de route
sidebar_position: 20
---

# Développement et architecture

Cette page s'adresse à celles et ceux qui veulent comprendre le fonctionnement interne ou contribuer. Pour utiliser Homelab Manager, voir le [Démarrage rapide](demarrage-rapide.md).

## Architecture

```
            navigateur ──REST + SSE──┐
                                     ▼
┌──────────┐ WebSocket sortant   ┌─────────┐      ┌─────────┐
│  agent   │ ──── mTLS :3443 ──► │   hub   │ ───► │ MongoDB │
│ (Go, root│ ◄── ordres (JSON) ─ │ Node.js │      └─────────┘
│ systemd) │                     │ + React │
└──────────┘                     └─────────┘
```

- **`agent/`** (Go, binaire statique d'environ 6 Mo). Il ouvre une connexion WebSocket **sortante** vers le hub, en TLS mutuel (port 3443) et se reconnecte tout seul : le délai entre deux essais part de 1 s et augmente de 20 % à chaque échec, jusqu'à 30 s, avec un aléa de ±20 % pour que les agents ne reviennent pas tous en même temps. Un redémarrage du hub est donc rattrapé en quelques secondes. Il remonte l'état du système et des paquets, et exécute uniquement une liste blanche d'actions (`apt_report`, `apt_update`, `apt_upgrade`). Il n'exécute jamais de commande arbitraire, et les noms de paquets sont validés des deux côtés.
- **`hub/`** (Node.js, Fastify, TypeScript). Sur le port 3000 : API REST sous `/api`, flux temps réel pour l'UI (Server-Sent Events sur `/api/events`). Sur le port 3443 (TLS, autorité de certification interne) : script d'installation, binaires de l'agent et leurs signatures, enrôlement (`/agent/enroll`), WebSocket des agents (`/agent/ws`).
- **`web/`** (React, Vite, Tailwind, TanStack Query). Servi par le hub en production.

### Sécurité

- Comptes avec trois profils (`admin`, `operator`, `viewer`) vérifiés côté hub ; compte `superadmin` à mot de passe à usage unique (premier démarrage, ou `hm-admin superadmin` dans le conteneur) qui ne gère que les comptes ([Comptes et profils](comptes.md)). Mots de passe hachés en scrypt, session en cookie `HttpOnly` / `SameSite=Strict`, limitation des tentatives de connexion.
- Agents : TLS avec la clé du hub épinglée dans la commande d'installation, code d'installation à usage unique (24 h, stocké haché), clé privée générée sur l'hôte et certificat client par agent (mTLS), révocation immédiate. Binaires de l'agent signés (Ed25519) et vérifiés à chaque mise à jour. Détails et limites : [Sécurité](securite.md).
- Conçu pour rester sur le LAN : ne l'expose pas sur Internet sans reverse proxy HTTPS et authentification supplémentaire.

### API REST (extrait)

| Méthode | Route | Description |
| --- | --- | --- |
| `GET` | `/api/hosts` | Liste des hôtes avec leur état |
| `POST` | `/api/hosts` | Crée un hôte et renvoie la commande d'installation (code à usage unique) |
| `PATCH` / `DELETE` | `/api/hosts/:id` | Modifie / supprime un hôte |
| `POST` | `/api/hosts/:id/enroll` | Nouvelle commande d'installation (annule la précédente) |
| `POST` | `/api/hosts/:id/revoke` | Révoque l'agent : déconnexion, certificat refusé |
| `GET` | `/api/hosts/:id/alerts` | Alertes des 30 derniers jours (APT, Docker, sauvegardes) : pire niveau de chaque jour et raisons |
| `POST` | `/api/hosts/:id/jobs` | Lance `apt_update` / `apt_upgrade` (avec `packages` optionnel), `docker_check`, ou `docker_up` / `docker_stop` / `docker_restart` / `docker_update` avec `stack` (et `service` optionnel) |
| `GET` | `/api/hosts/:id/stacks/:stack/logs` | Dernières lignes des logs d'une stack (`service`, `tail`) |
| `GET` | `/api/hosts/:id/stacks/:stack/compose` | Fichiers compose de la stack (`.env` masqué) |
| `DELETE` | `/api/hosts/:id/stacks/:stack` | Oublie une stack sans conteneur |
| `POST` | `/api/jobs/bulk` | Même action sur plusieurs hôtes |
| `GET` | `/api/jobs`, `/api/jobs/:id` | Historique, détail avec logs |
| `GET` | `/api/events` | Flux SSE (`host`, `job`, `job.log`) |
| `GET` / `POST` | `/api/users` | Liste / crée un compte (admin) |
| `PATCH` / `DELETE` | `/api/users/:id` | Modifie / supprime un compte (admin) |
| `POST` | `/api/users/:id/reset-password` | Efface le mot de passe : l'utilisateur en choisit un nouveau à la connexion |

## Développement

Prérequis : Node.js 24, Go 1.27 (le `toolchain` de `agent/go.mod` est téléchargé au besoin), GNU Make, Docker pour l'image, et un MongoDB accessible (défaut `mongodb://localhost:27017/homelab`, `make start MONGO_URL=…` sinon). `make` (ou `make help`) liste toutes les commandes.

```sh
make install            # dépendances hub + web + agent
make dev                # hub (rechargement auto) + interface sur http://localhost:5173, Ctrl-C arrête tout
                        # avec HTTPS_PORT figé dans .env.local : aussi https://localhost:<port> (dernier build de web/)
make agent-run CODE=…   # agent local enrôlé avec le code d'une commande d'installation (en root pour apt-get)
```

| Commande | Rôle |
| --- | --- |
| `make start` | Build complet puis hub en mode production (UI servie sur le port 3000) ; `PORT=`, `LOG=`, `MONGO_URL=` pour changer |
| `make lint` | gofmt, go vet, typage du hub, eslint de l'interface |
| `make test` | Tests unitaires agent + hub |
| `make agent` | Agent amd64 + arm64 dans `agent/dist` (servi par le hub) ; build de la version de l'agent +1 si ses sources ont changé |
| `make agent-minor` / `agent-major` | Version de l'agent X.Y+1.0 / X+1.0.0, puis compile |
| `make build` | Agent (amd64 + arm64), hub et interface |
| `make check` | lint + test + build : ce que lance la CI |
| `make audit` | Vulnérabilités connues, bloquant en sévérité élevée : `npm audit` des dépendances livrées (hub, interface), `govulncheck` de l'agent (Linux et Windows) ; la CI le lance avec un scan de secrets (gitleaks) |
| `make docker-build` | Image locale `homelab-manager:latest` (agents signés si la clé de release est présente) |
| `make release-key` | Crée la clé de signature des agents (une fois) |

### Release

Les releases se font en local et publient sur Docker Hub, comme pour komodo2mqtt, en deux temps : chaque release part sur le canal **dev** (tags `dev` et `X.Y.Z-dev`) ; seule la **promotion** publie la prod (`X.Y.Z` et `latest`, le tag de l'image publique et de la doc d'installation). Elles signent les binaires de l'agent : une fois pour toutes, `make release-key` crée la clé privée (`~/.config/homelab-manager/release.key`, à sauvegarder, jamais dans le dépôt) et `agent/release.pub`, à commiter.

```sh
docker login
make docker-release         # X.Y.Z → X.Y.Z+1
make docker-release-minor   # X.Y.Z → X.Y+1.0
make docker-release-major   # X.Y.Z → X+1.0.0
make docker-promote         # prod : X.Y.Z-dev → X.Y.Z + latest (VERSION=X.Y.Z pour une autre version dev)
```

Une release lance d'abord `make check`. Elle refuse un arbre de travail non commité, ou une clé de release absente ou qui ne correspond pas à `agent/release.pub`. Ensuite elle :
1. met à jour la version (`VERSION`, `hub/` et `web/package.json`) et la commite (« 🔖 Release X.Y.Z ») ;
2. construit l'image amd64 + arm64 (binaires de l'agent signés, clé passée en secret BuildKit) et la pousse sous les tags `dev`, `X.Y.Z-dev` et le hash du commit ;
3. crée le tag git `vX.Y.Z`, pousse le commit et le tag, puis lance la synchro des applications HAOS **dev** (`homelab-manager-haos`).

`make docker-promote` (après confirmation, `YES=1` pour s'en passer) republie l'image `X.Y.Z-dev` telle quelle, sans rebuild et pour toutes ses architectures, sous `X.Y.Z` et `latest`, crée la release GitHub `vX.Y.Z` (notes = section « Non publié » du `CHANGELOG.md`, renommée en version et commitée/poussée par la promotion ; à défaut, notes générées par GitHub depuis la dernière release publiée), puis lance la synchro des applications HAOS **prod**. Le tag `vX.Y.Z` doit exister sur origin (posé par `docker-release`). Une version déjà en prod est refusée. La stack du CT 171 (`make publish`, `make docker-direct`) suit le tag `dev`. `make publish` épingle l'image du hub par son empreinte dans le compose du CT (`image: mathmath350/homelab-manager:dev@sha256:…`, ancien fichier gardé en `docker-compose.yml.bak`) avant de la récupérer : le déploiement est celui de l'empreinte lue à cet instant, pas celui d'un tag qui peut bouger. Retour arrière : remettre le `.bak` en place puis `docker compose up -d`.

`DOCKER_USER` (défaut `mathmath350`), `PLATFORMS` (défaut `linux/amd64,linux/arm64`) et `RELEASE_KEY` sont surchargeables.

### Version de l'agent

L'agent a sa propre version, `agent/VERSION` (X.Y.Z), indépendante de celle de l'application ; une release ne la modifie pas, l'image embarque les binaires compilés avec la version commitée.

- `make agent` (lancé aussi par `make dev` et `make build`) incrémente le build (X.Y.Z+1) seulement si les sources de l'agent (`*.go` hors tests, `go.mod`, `go.sum`) ont changé depuis le dernier build ; sinon il ne recompile rien. L'empreinte du dernier build est dans `agent/.build-hash` (non versionné ; absent, la version courante est compilée sans incrément).
- `make agent-minor` / `make agent-major` pour un changement de mineur ou de majeur.
- `agent/VERSION` modifié se commite avec le code de l'agent.
- Les binaires sont reproductibles (`-trimpath -buildvcs=false`) : le hub détecte un agent obsolète par l'empreinte de son binaire, un commit qui ne touche pas l'agent ne doit donc pas la changer.

## Feuille de route

- [x] Hub, agents, inventaire et mises à jour APT
- [x] Docker : état des stacks compose et des conteneurs, mises à jour des images, actions, logs
- [ ] Docker : stacks synchronisées hôte ↔ hub (édition, détection de dérive, push, rollback)
- [ ] Alertes (ntfy, MQTT, Telegram…)
- [x] Sauvegardes : suivi PBS et Proxmox VE, sauvegardes de répertoires pilotées, alertes
- [ ] Standardisation : profils de paquets, clés SSH, accès
- [x] Santé : métriques système légères, alertes à seuil, SMART
