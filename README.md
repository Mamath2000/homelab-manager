# Homelab Manager

Administration d'un homelab (une vingtaine de serveurs, VM et LXC) depuis une seule interface : état des hôtes, mises à jour système (APT), stacks Docker, et bientôt sauvegardes et standardisation des hôtes.

Pensé pour le réseau local : un hub en conteneur, un agent léger par hôte, aucun port à ouvrir sur les hôtes.

![Tableau de bord](docs/img/dashboard.png)

## Fonctionnalités (MVP)

- **Inventaire** des hôtes : OS, noyau, architecture, virtualisation (LXC, KVM…), IP, uptime, état de connexion en temps réel.
- **Mises à jour APT** : paquets à mettre à jour, mises à jour de sécurité, paquets bloqués (`hold`), redémarrage requis, ancienneté des listes de paquets.
- **Actions depuis l'UI** : `apt-get update`, mise à jour complète ou sélection de paquets, sur un hôte ou en masse. Les logs s'affichent en direct.
- **Vue par paquet** : « openssl est à mettre à jour sur 14 hôtes », et mise à jour en un clic partout.
- **Vérification planifiée** : le hub demande aux agents de rafraîchir leurs listes de paquets toutes les 12 h (configurable).
- **Redémarrage** des hôtes depuis l'interface ou Home Assistant.
- **Mise à jour automatique des agents** : chaque agent obsolète (empreinte différente du binaire distribué par le hub) est signalé et se met à jour seul, après vérification de la signature du binaire.
- **Échanges sécurisés** avec les agents : TLS avec la clé du hub épinglée, commande d'installation à usage unique, un certificat par agent, révocation en un clic. Voir [docs/securite.md](docs/securite.md).
- **Nettoyage** : paquets devenus inutiles (anciens noyaux, dépendances orphelines) détectés par simulation d'`apt autoremove`, supprimables depuis l'interface ou Home Assistant.
- **Docker** : stacks compose des hôtes découvertes automatiquement, état des conteneurs et santé, images à mettre à jour (vérifiées auprès du registre sans rien télécharger), démarrer / arrêter / redémarrer / mettre à jour une stack ou un service, logs et fichiers compose (`.env` masqué). Voir [docs/docker.md](docs/docker.md).
- **Historique** des tâches avec leurs sorties (conservé 90 jours).
- **Home Assistant** (option, dans les Paramètres) : publication MQTT avec découverte automatique *device-based*. Hiérarchie Homelab Manager > hôtes > composants (APT…), alertes remontées vers l'hôte puis la racine, mises à jour installables depuis HA. Voir [docs/home-assistant.md](docs/home-assistant.md).
- Interface **dark**, en français, utilisable sur mobile.

| Fiche hôte | Vue par paquet |
| --- | --- |
| ![Fiche hôte](docs/img/host.png) | ![Mises à jour](docs/img/updates.png) |

## Installation

### 1. Le hub

Récupère [`compose.yml`](compose.yml), ajuste-le si besoin (port publié, niveau de logs, reverse proxy), puis :

```sh
docker compose up -d
```

L'image `mathmath350/homelab-manager` est multi-arch (amd64, arm64). Au premier démarrage, le hub affiche dans ses logs le mot de passe à usage unique du compte `superadmin` :

```sh
docker compose logs hub
```

Le hub publie deux ports : `3000` pour l'interface et `3443` pour les agents (TLS).

Ouvre `http://<ip-du-hub>:3000`, connecte-toi en `superadmin` avec ce mot de passe et crée les comptes (page **Comptes**). Chaque compte reçoit un mot de passe temporaire, à changer à la première connexion.

Gestion des comptes, rôles et récupération d'accès : voir [docs/comptes.md](docs/comptes.md).

### 2. Les agents

Dans l'UI : **Ajouter un hôte**, puis copie la commande affichée et lance-la en root sur l'hôte :

```sh
curl -fsSLk --pinnedpubkey sha256//<clé-du-hub> https://<ip-du-hub>:3443/install.sh | sh -s -- <code>
```

La commande épingle la clé du hub et contient un code à usage unique, valable 24 h. Le script télécharge le binaire de l'agent pour la bonne architecture (amd64 / arm64), l'agent génère sa clé privée et obtient son certificat auprès du hub, puis le service systemd `homelab-agent` démarre. L'hôte apparaît en ligne quelques secondes plus tard.

Les commandes de mise à jour manuelle (certificat conservé) et de désinstallation sont dans **Paramètres > Agent**.

Prérequis côté hôte : Debian ou Ubuntu avec systemd, ou Unraid ; `curl`. L'agent peut s'installer dans un répertoire au choix (`--dir`, voir [docs/installation.md](docs/installation.md)).

Agents installés avant la connexion TLS : le hub les refuse et les marque « Réinstallation requise » ; relancer sur chaque hôte une commande d'installation générée depuis sa fiche ([docs/installation.md](docs/installation.md)).

## Configuration du hub

Déploiement : variables d'environnement écrites dans [`compose.yml`](compose.yml). En local, le Makefile les fixe (`make start PORT=4000 LOG=debug`).

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `MONGO_URL` | `mongodb://localhost:27017/homelab` | Base MongoDB |
| `PORT` | `3000` | Port d'écoute de l'interface et de l'API (3000 dans l'image ; port publié choisi dans `compose.yml`) |
| `AGENT_TLS_PORT` | `3443` | Port d'écoute TLS des agents |
| `LOG_LEVEL` | `info` | Niveau de logs |
| `SESSION_DAYS` | `30` | Durée des sessions |
| `COOKIE_SECURE` | `false` | `true` si le hub est servi en HTTPS |
| `TRUST_PROXY` | `false` | `true` derrière un reverse proxy |

Paramètres de l'application, dans l'interface (**Paramètres > Agent**) : **URL du hub** (vide : celle du navigateur ; les agents utilisent son nom d'hôte), **port TLS des agents** (port publié, 3443 par défaut), et fréquence de l'`apt-get update` automatique (12 h par défaut, `0` = désactivé). La page affiche aussi la clé épinglée et l'empreinte de l'autorité de certification du hub.

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

- Comptes avec trois rôles (`admin`, `operator`, `viewer`) vérifiés côté hub ; compte `superadmin` à mot de passe à usage unique (premier démarrage, ou `hm-admin superadmin` dans le conteneur) qui ne gère que les comptes ([docs/comptes.md](docs/comptes.md)). Mots de passe hachés en scrypt, session en cookie `HttpOnly` / `SameSite=Strict`, limitation des tentatives de connexion.
- Agents : TLS avec la clé du hub épinglée dans la commande d'installation, code d'installation à usage unique (24 h, stocké haché), clé privée générée sur l'hôte et certificat client par agent (mTLS), révocation immédiate. Binaires de l'agent signés (Ed25519) et vérifiés à chaque mise à jour. Détails et limites : [docs/securite.md](docs/securite.md).
- Conçu pour rester sur le LAN : ne l'expose pas sur Internet sans reverse proxy HTTPS et authentification supplémentaire.

### API REST (extrait)

| Méthode | Route | Description |
| --- | --- | --- |
| `GET` | `/api/hosts` | Liste des hôtes avec leur état |
| `POST` | `/api/hosts` | Crée un hôte et renvoie la commande d'installation (code à usage unique) |
| `PATCH` / `DELETE` | `/api/hosts/:id` | Modifie / supprime un hôte |
| `POST` | `/api/hosts/:id/enroll` | Nouvelle commande d'installation (annule la précédente) |
| `POST` | `/api/hosts/:id/revoke` | Révoque l'agent : déconnexion, certificat refusé |
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

Prérequis : Node.js 22, Go 1.24, GNU Make, Docker pour l'image, et un MongoDB accessible (défaut `mongodb://localhost:27017/homelab`, `make start MONGO_URL=…` sinon). `make` (ou `make help`) liste toutes les commandes.

```sh
make install            # dépendances hub + web + agent
make dev                # hub (rechargement auto) + interface sur http://localhost:5173, Ctrl-C arrête tout
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
| `make docker-build` | Image locale `homelab-manager:latest` (agents signés si la clé de release est présente) |
| `make release-key` | Crée la clé de signature des agents (une fois) |

### Release

Les releases se font en local et publient sur Docker Hub, comme pour komodo2mqtt. Elles signent les binaires de l'agent : une fois pour toutes, `make release-key` crée la clé privée (`~/.config/homelab-manager/release.key`, à sauvegarder, jamais dans le dépôt) et `agent/release.pub`, à commiter.

```sh
docker login
make docker-release         # X.Y.Z → X.Y.Z+1
make docker-release-minor   # X.Y.Z → X.Y+1.0
make docker-release-major   # X.Y.Z → X+1.0.0
git push origin main --tags
```

Une release lance d'abord `make check`. Elle refuse un arbre de travail non commité, ou une clé de release absente ou qui ne correspond pas à `agent/release.pub`. Ensuite elle :
1. met à jour la version (`VERSION`, `hub/` et `web/package.json`) et la commite (« 🔖 Release X.Y.Z ») ;
2. construit l'image amd64 + arm64 (binaires de l'agent signés, clé passée en secret BuildKit) et la pousse sous les tags `latest`, `X.Y.Z` et le hash du commit ;
3. crée le tag git `vX.Y.Z`.

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
- [ ] Suivi des sauvegardes (heartbeats, alertes en cas d'échec ou d'absence)
- [ ] Standardisation : profils de paquets, clés SSH, accès
- [ ] Métriques système légères
