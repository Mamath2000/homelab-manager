# Homelab Manager

Administration d'un homelab (une vingtaine de serveurs, VM et LXC) depuis une seule interface : état des hôtes, mises à jour système (APT), et bientôt stacks Docker, sauvegardes et standardisation des hôtes.

Pensé pour le réseau local : un hub en conteneur, un agent léger par hôte, aucun port à ouvrir sur les hôtes.

![Tableau de bord](docs/dashboard.png)

## Fonctionnalités (MVP)

- **Inventaire** des hôtes : OS, noyau, architecture, virtualisation (LXC, KVM…), IP, uptime, état de connexion en temps réel.
- **Mises à jour APT** : paquets à mettre à jour, mises à jour de sécurité, paquets bloqués (`hold`), redémarrage requis, ancienneté des listes de paquets.
- **Actions depuis l'UI** : `apt-get update`, mise à jour complète ou sélection de paquets, sur un hôte ou en masse. Les logs s'affichent en direct.
- **Vue par paquet** : « openssl est à mettre à jour sur 14 hôtes », et mise à jour en un clic partout.
- **Vérification planifiée** : le hub demande aux agents de rafraîchir leurs listes de paquets toutes les 12 h (configurable).
- **Historique** des tâches avec leurs sorties (conservé 90 jours).
- Interface **dark**, en français, utilisable sur mobile.

| Fiche hôte | Vue par paquet |
| --- | --- |
| ![Fiche hôte](docs/host.png) | ![Mises à jour](docs/updates.png) |

## Installation

### 1. Le hub

```yaml
# compose.yml
services:
  hub:
    image: ghcr.io/mamath2000/homelab-manager:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      MONGO_URL: mongodb://mongo:27017/homelab
      # PUBLIC_URL: http://192.168.1.10:3000
      CHECK_INTERVAL_HOURS: 12
    depends_on:
      - mongo
  mongo:
    image: mongo:7          # mongo:4.4 sur un CPU sans AVX
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db
volumes:
  mongo-data:
```

```sh
docker compose up -d
```

Ouvre `http://<ip-du-hub>:3000`. Au premier lancement, l'interface te demande de créer le compte administrateur.

### 2. Les agents

Dans l'UI : **Ajouter un hôte**, puis copie la commande affichée et lance-la en root sur l'hôte :

```sh
curl -fsSL http://<ip-du-hub>:3000/install.sh | sh -s -- <token>
```

Le script télécharge le binaire de l'agent pour la bonne architecture (amd64 / arm64) depuis le hub, puis installe le service systemd `homelab-agent`. L'hôte apparaît en ligne quelques secondes plus tard.

| Action | Commande |
| --- | --- |
| Mettre à jour l'agent (token conservé) | `curl -fsSL http://<hub>:3000/install.sh \| sh` |
| Désinstaller | `curl -fsSL http://<hub>:3000/install.sh \| sh -s -- --uninstall` |

Prérequis côté hôte : Debian ou Ubuntu, systemd, `curl` ou `wget`.

## Configuration du hub

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `MONGO_URL` | `mongodb://localhost:27017/homelab` | Base MongoDB |
| `PORT` | `3000` | Port HTTP |
| `PUBLIC_URL` | URL utilisée dans le navigateur | URL par laquelle les agents joignent le hub |
| `CHECK_INTERVAL_HOURS` | `12` | Fréquence de l'`apt-get update` automatique (`0` = désactivé) |
| `SESSION_DAYS` | `30` | Durée des sessions |
| `COOKIE_SECURE` | `false` | `true` si le hub est servi en HTTPS |
| `TRUST_PROXY` | `false` | `true` derrière un reverse proxy |
| `LOG_LEVEL` | `info` | Niveau de logs |

## Architecture

```
            navigateur ──REST + SSE──┐
                                     ▼
┌──────────┐  WebSocket sortant  ┌─────────┐      ┌─────────┐
│  agent   │ ──────────────────► │   hub   │ ───► │ MongoDB │
│ (Go, root│ ◄── ordres (JSON) ─ │ Node.js │      └─────────┘
│ systemd) │                     │ + React │
└──────────┘                     └─────────┘
```

- **`agent/`** (Go, binaire statique d'environ 6 Mo). Il ouvre une connexion WebSocket **sortante** vers le hub et se reconnecte tout seul. Il remonte l'état du système et des paquets, et exécute uniquement une liste blanche d'actions (`apt_report`, `apt_update`, `apt_upgrade`). Il n'exécute jamais de commande arbitraire, et les noms de paquets sont validés des deux côtés.
- **`hub/`** (Node.js, Fastify, TypeScript). API REST sous `/api`, flux temps réel pour l'UI (Server-Sent Events sur `/api/events`), WebSocket des agents sur `/agent/ws`, script d'installation et binaires de l'agent.
- **`web/`** (React, Vite, Tailwind, TanStack Query). Servi par le hub en production.

### Sécurité

- Un seul compte admin. Mot de passe haché en scrypt, session en cookie `HttpOnly` / `SameSite=Strict`, limitation des tentatives de connexion.
- Un token par agent, de la forme `<hostId>.<secret>`. Seul le hash du secret est stocké, et régénérer le token déconnecte immédiatement l'ancien agent.
- Conçu pour rester sur le LAN : ne l'expose pas sur Internet sans reverse proxy HTTPS et authentification supplémentaire.

### API REST (extrait)

| Méthode | Route | Description |
| --- | --- | --- |
| `GET` | `/api/hosts` | Liste des hôtes avec leur état |
| `POST` | `/api/hosts` | Crée un hôte et renvoie son token et la commande d'installation |
| `PATCH` / `DELETE` | `/api/hosts/:id` | Modifie / supprime un hôte |
| `POST` | `/api/hosts/:id/token` | Régénère le token |
| `POST` | `/api/hosts/:id/jobs` | Lance `apt_update` / `apt_upgrade` (avec `packages` optionnel) |
| `POST` | `/api/jobs/bulk` | Même action sur plusieurs hôtes |
| `GET` | `/api/jobs`, `/api/jobs/:id` | Historique, détail avec logs |
| `GET` | `/api/events` | Flux SSE (`host`, `job`, `job.log`) |

## Développement

Prérequis : Node.js 22, Go 1.24 et un MongoDB local.

```sh
# hub (http://localhost:3000)
cd hub && npm install && npm run dev

# interface (http://localhost:5173, proxy vers le hub)
cd web && npm install && npm run dev

# agent : à lancer en root sur une machine Debian/Ubuntu
cd agent && go run . -hub http://localhost:3000 -token <token>
# pour que le hub serve le binaire aux scripts d'installation :
CGO_ENABLED=0 go build -o dist/homelab-agent-linux-amd64 .
```

Vérifications (aussi lancées par la CI) :

```sh
cd agent && go vet ./... && go test ./...
cd hub && npm run typecheck && npm test
cd web && npm run lint && npm run build
```

À chaque push sur `main`, la CI publie l'image multi-arch `ghcr.io/mamath2000/homelab-manager`.

## Feuille de route

- [x] Hub, agents, inventaire et mises à jour APT
- [ ] Docker : état des conteneurs, stacks compose synchronisées hôte ↔ hub (détection de dérive, push, rollback)
- [ ] Alertes (ntfy, MQTT, Telegram…)
- [ ] Suivi des sauvegardes (heartbeats, alertes en cas d'échec ou d'absence)
- [ ] Standardisation : profils de paquets, clés SSH, accès
- [ ] Métriques système légères
