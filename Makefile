# Makefile pour homelab-manager — `make` ou `make help` liste les commandes
.PHONY: help install dev start logs stop agent agent-minor agent-major agent-floor agent-run build lint fmt test check audit clean version \
        docs-site docs-serve \
        docker-build docker-prune hardened-pin release-key \
        docker-release docker-release-minor docker-release-major docker-promote docker-direct publish
.DEFAULT_GOAL := help

VERSION   := $(shell cat VERSION)
# Réglages propres à cette machine (gitignoré) : ports du hub de test figés par `override`, ex. :
#   override PORT := 3001
#   override AGENT_TLS_PORT := 3444
#   override HTTPS_PORT := 3445     (facultatif : port HTTPS de l'interface, https://localhost:3445)
-include .env.local
# Lancement local (make dev / make start), surchargeable (sauf ce que .env.local fige) : make start LOG=debug
PORT      ?= 3000
LOG       ?= info
MONGO_URL ?= mongodb://localhost:27017/homelab
LOG_FILE  ?= $(CURDIR)/logs/hub.log
HUB       ?= http://localhost:$(PORT)
AGENT_TLS_PORT ?= 3443
# Port HTTPS de l'interface, facultatif (vide : désactivé) ; à figer dans .env.local comme les deux autres
HTTPS_PORT ?=
RUN_ENV   := export PORT=$(PORT) AGENT_TLS_PORT=$(AGENT_TLS_PORT) HTTPS_PORT=$(HTTPS_PORT) LOG_LEVEL=$(LOG) LOG_FILE=$(LOG_FILE) MONGO_URL=$(MONGO_URL);
# Agent local (make agent-run) : adresse TLS du hub et dossier de configuration (certificat, clé)
AGENT_HUB ?= https://localhost:$(AGENT_TLS_PORT)
AGENT_DIR ?= $(CURDIR)/agent/.dev
# Clé privée de signature des binaires de l'agent, hors du dépôt (make release-key)
RELEASE_KEY ?= $(HOME)/.config/homelab-manager/release.key
export RELEASE_KEY
# Stack de prod (make publish) : hôte ssh, CT Proxmox (vide = l'hôte ssh lui-même), dossier du compose
PROD_SSH  ?= pve1.lo
PROD_PCT  ?= 171
PROD_DIR  ?= /home/mamath/homelab-manager
PROD_COMPOSE ?= docker-compose.yml
# Site public de la doc (make docs-serve) : port local du build servi
DOCS_PORT ?= 3100
PROD_RUN   = ssh $(PROD_SSH) "$(if $(PROD_PCT),pct exec $(PROD_PCT) -- )sh -c 'cd $(PROD_DIR) && $(1)'"

help: ## Affiche cette aide
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[32m%-22s\033[0m %s\n", $$1, $$2}'

version: ## Affiche la version courante
	@echo $(VERSION)

# --- Installation et développement -------------------------------------------

install: ## Installe les dépendances (npm ci hub + web, go mod download)
	cd hub && npm ci
	cd web && npm ci
	cd agent && go mod download

dev: agent ## Lance hub (rechargement auto) + interface Vite sur http://localhost:5173 ; Ctrl-C arrête tout
	@echo "hub : $(HUB)   ·   interface : http://localhost:5173$(if $(HTTPS_PORT),   ·   https : https://localhost:$(HTTPS_PORT))"
	@$(RUN_ENV) trap 'trap - INT TERM; kill 0' INT TERM; \
		(cd hub && npm run dev) & \
		(cd web && npm run dev) & \
		wait

start: build ## Build complet puis lance le hub comme en production : make start [PORT=3000] [LOG=info] [MONGO_URL=…]
	@$(RUN_ENV) cd hub && NODE_ENV=production node dist/index.js

logs: ## Suit le journal du hub local (logs/hub.log, JSON pino) : make logs [N=100]
	@tail -n $${N:-100} -f $(LOG_FILE)

stop: ## Arrête le hub et l'interface lancés par make dev / make start (processus node de hub/ et web/ de ce repo)
	@pids=$$(for p in $$(pgrep -u "$$(id -u)" -x 'node|npm.*|esbuild'); do \
		case "$$(readlink /proc/$$p/cwd 2>/dev/null)" in $(CURDIR)/hub|$(CURDIR)/web) echo $$p;; esac; \
	done); \
	if [ -z "$$pids" ]; then echo "Rien à arrêter"; exit 0; fi; \
	alive() { for p in $$pids; do case "$$(ps -o stat= -p $$p 2>/dev/null)" in ""|Z*) ;; *) echo $$p;; esac; done; }; \
	kill $$pids 2>/dev/null; \
	for i in $$(seq 30); do [ -z "$$(alive)" ] && break; sleep 0.2; done; \
	forced=$$(alive); \
	if [ -n "$$forced" ]; then kill -9 $$forced 2>/dev/null; sleep 0.5; fi; \
	echo "Arrêté :" $$pids; \
	[ -z "$$forced" ] || echo "Tué de force (SIGTERM ignoré pendant 6 s) :" $$forced; \
	left=$$(alive); [ -z "$$left" ] || { echo "Toujours actif :" $$left; exit 1; }

agent: ## Compile l'agent (Linux amd64 + arm64, Windows amd64, agent/dist) ; version agent/VERSION, build +1 si les sources ont changé
	@./agent/build.sh

agent-minor: ## Version mineure de l'agent +1 (X.Y+1.0), puis compile
	@./agent/build.sh minor

agent-major: ## Version majeure de l'agent +1 (X+1.0.0), puis compile
	@./agent/build.sh major

agent-floor: ## Plancher des mises à jour de l'agent (anti-rollback) = version courante de l'agent : à commiter dans la release qui corrige une faille de l'agent
	@old=$$(cat agent/MIN_VERSION); new=$$(cat agent/VERSION); echo "$$new" > agent/MIN_VERSION; \
		echo "agent/MIN_VERSION : $$old → $$new (les agents de release refuseront toute version plus ancienne)"; \
		echo "à commiter : git commit -m \"🔒 Plancher agent $$new\" agent/MIN_VERSION"

agent-run: ## Lance l'agent en local (root pour apt-get) : make agent-run [CODE=<code de la commande d'installation>]
	@mkdir -p $(AGENT_DIR)
	@# dev only: the CA is taken from install.sh without pinning (local hub)
	@if [ -n "$(CODE)" ]; then \
		curl -fsSk $(AGENT_HUB)/install.sh | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' > $(AGENT_DIR)/ca.pem && \
		cd agent && go run . enroll -hub $(AGENT_HUB) -dir $(AGENT_DIR) -code $(CODE); \
	fi
	@[ -f $(AGENT_DIR)/agent.crt ] || { echo "Agent non enrôlé : make agent-run CODE=<code de la commande d'installation>"; exit 1; }
	cd agent && go run -ldflags "-X main.version=$$(cat VERSION)-dev" . -hub $(AGENT_HUB) -dir $(AGENT_DIR)

# --- Qualité -------------------------------------------------------------------

fmt: ## Formate le code Go
	gofmt -w agent

lint: ## Vérifications statiques : gofmt, go vet, typage du hub, eslint de l'interface
	@unformatted="$$(gofmt -l agent)"; [ -z "$$unformatted" ] || { echo "gofmt à appliquer (make fmt) :"; echo "$$unformatted"; exit 1; }
	cd agent && go vet ./...
	cd agent && GOOS=windows go vet ./...
	cd hub && npm run typecheck
	cd web && npm run lint

test: ## Tests unitaires (agent + hub)
	cd agent && go test ./...
	cd hub && npm test

build: agent ## Build complet : agent (Linux amd64 + arm64, Windows amd64), hub, interface
	cd hub && npm run build
	cd web && npm run build

check: lint test build ## Tout ce que lance la CI : lint + tests + build

# govulncheck is built with the toolchain of agent/go.mod: an older Go cannot load the sources of a newer standard library
GOVULNCHECK_VERSION := v1.9.0
GOVULNCHECK := $(CURDIR)/agent/.dev/bin/govulncheck
audit: ## Vulnérabilités connues, bloquant en sévérité élevée : npm audit (dépendances livrées du hub et de l'interface), govulncheck (agent Linux et Windows)
	cd hub && npm audit --omit=dev --audit-level=high
	cd web && npm audit --omit=dev --audit-level=high
	cd agent && GOTOOLCHAIN=$$(awk '/^toolchain/ {print $$2}' go.mod) GOBIN=$(dir $(GOVULNCHECK)) go install golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION)
	cd agent && $(GOVULNCHECK) ./...
	cd agent && GOOS=windows $(GOVULNCHECK) ./...

clean: ## Supprime les artefacts de build
	rm -rf agent/dist hub/dist web/dist website/build

# --- Documentation ---------------------------------------------------------------

docs-site: ## Build du site public de la doc (docs/ rendu par Docusaurus dans website/build, liens cassés bloquants) ; publié sur GitHub Pages par make docker-promote
	cd website && npm ci && npm run build

docs-serve: docs-site ## Sert le build du site public de la doc sur http://localhost:$(DOCS_PORT)/homelab-manager/ [DOCS_PORT=3100]
	cd website && npm run serve -- --port $(DOCS_PORT) --host 0.0.0.0 --no-open

# --- Docker ----------------------------------------------------------------------

release-key: ## Crée la clé de signature des agents (une fois) : clé privée dans RELEASE_KEY, agent/release.pub à commiter
	cd agent && go run ./cmd/hm-sign keygen -key $(RELEASE_KEY) -pub release.pub
	@echo "Clé privée : $(RELEASE_KEY) (à sauvegarder, jamais dans le dépôt)"
	@echo "Clé publique : agent/release.pub (à commiter : les agents de release l'embarquent)"

docker-build: ## Construit l'image locale homelab-manager:latest (sans push ; agents signés si la clé de release est présente)
	bash docker-release.sh build

docker-prune: ## Libère le disque : dist, anciennes images locales (garde latest, dev + version courante), images orphelines, cache buildx > 7 j
	bash docker-release.sh prune

hardened-pin: ## Affiche les empreintes (digest) des images de compose.hardened.yml : make hardened-pin TAG=1.2.24 (défaut : latest)
	@for img in mathmath350/homelab-manager:$(or $(TAG),latest) mongo:8.0; do \
		d=$$(docker buildx imagetools inspect $$img 2>/dev/null | awk '/^Digest:/ {print $$2; exit}'); \
		if [ -n "$$d" ]; then echo "$${img%%:*}@$$d   # $$img"; else echo "empreinte introuvable : $$img" >&2; exit 1; fi; \
	done

docker-release: check ## Release dev : build +1 (X.Y.Z+1), commit, build et push Docker Hub (dev, X.Y.Z-dev ; amd64 + arm64), tag git, push, synchro HAOS dev (workflow GitHub) et nettoyage disque
	bash docker-release.sh release

docker-release-minor: check ## Release dev : mineur +1, build remis à 0 (X.Y+1.0), commit, build et push dev, tag git, push, synchro HAOS dev (workflow GitHub) et nettoyage disque
	bash docker-release.sh release-minor

docker-release-major: check ## Release dev : majeur +1, mineur et build à 0 (X+1.0.0), commit, build et push dev, tag git, push, synchro HAOS dev (workflow GitHub) et nettoyage disque
	bash docker-release.sh release-major

docker-promote: ## Prod : publie l'image X.Y.Z-dev telle quelle sous X.Y.Z et latest, release GitHub vX.Y.Z (notes = CHANGELOG « Non publié »), puis synchro HAOS prod et doc publique (GitHub Pages) [VERSION=X.Y.Z, défaut : version courante] [YES=1]
	PROMOTE_VERSION=$(VERSION) YES=$(YES) bash docker-release.sh promote

docker-direct: check ## Contournement de Docker Hub : build amd64, image transférée par ssh au hub (CT 171) et service recréé [YES=1] [DIRECT_SSH=… DIRECT_PCT=… DIRECT_DIR=…]
	YES=$(YES) bash docker-release.sh direct

publish: ## Stack du CT : épingle l'image dev du hub par son empreinte (image: …:dev@sha256:…, ancien fichier gardé en .bak), la récupère (Docker Hub) et relance la stack (docker compose up -d), puis supprime les images orphelines (docker image prune) [YES=1]
	@echo "Stack de prod : $(PROD_SSH)$(if $(PROD_PCT), / CT $(PROD_PCT)):$(PROD_DIR)"
	@[ "$(YES)" = 1 ] || { printf "Mettre à jour le hub et relancer la stack ? [o/N] "; read a; case "$$a" in o|O|oui|y|Y) ;; *) echo "Annulé"; exit 1 ;; esac; }
	@digest=$$(docker buildx imagetools inspect mathmath350/homelab-manager:dev 2>/dev/null | awk '/^Digest:/ {print $$2; exit}'); \
		case "$$digest" in sha256:*) ;; *) echo "empreinte de mathmath350/homelab-manager:dev introuvable : publication annulée, rien modifié" >&2; exit 1 ;; esac; \
		echo "Image : mathmath350/homelab-manager:dev@$$digest"; \
		$(call PROD_RUN,COMPOSE_FILE=$(PROD_COMPOSE) sh -s -- $$digest) < tools/pin-image.sh
	$(call PROD_RUN,docker compose pull hub && docker compose up -d && docker compose ps && docker image prune -f)
