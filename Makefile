# Makefile pour homelab-manager — `make` ou `make help` liste les commandes
.PHONY: help install dev start stop agent agent-minor agent-major agent-run build lint fmt test check clean version \
        docker-build release-key \
        docker-release docker-release-minor docker-release-major docker-direct
.DEFAULT_GOAL := help

VERSION   := $(shell cat VERSION)
# Lancement local (make dev / make start), surchargeable : make start PORT=4000 LOG=debug
PORT      ?= 3000
LOG       ?= info
MONGO_URL ?= mongodb://localhost:27017/homelab
HUB       ?= http://localhost:$(PORT)
AGENT_TLS_PORT ?= 3443
RUN_ENV   := export PORT=$(PORT) AGENT_TLS_PORT=$(AGENT_TLS_PORT) LOG_LEVEL=$(LOG) MONGO_URL=$(MONGO_URL);
# Agent local (make agent-run) : adresse TLS du hub et dossier de configuration (certificat, clé)
AGENT_HUB ?= https://localhost:$(AGENT_TLS_PORT)
AGENT_DIR ?= $(CURDIR)/agent/.dev
# Clé privée de signature des binaires de l'agent, hors du dépôt (make release-key)
RELEASE_KEY ?= $(HOME)/.config/homelab-manager/release.key
export RELEASE_KEY

help: ## Affiche cette aide
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[32m%-22s\033[0m %s\n", $$1, $$2}'

version: ## Affiche la version courante
	@echo $(VERSION)

# --- Installation et développement -------------------------------------------

install: ## Installe les dépendances (npm ci hub + web, go mod download)
	cd hub && npm ci
	cd web && npm ci
	cd agent && go mod download

dev: agent ## Lance hub (rechargement auto) + interface Vite sur http://localhost:5173 ; Ctrl-C arrête tout
	@echo "hub : $(HUB)   ·   interface : http://localhost:5173"
	@$(RUN_ENV) trap 'trap - INT TERM; kill 0' INT TERM; \
		(cd hub && npm run dev) & \
		(cd web && npm run dev) & \
		wait

start: build ## Build complet puis lance le hub comme en production : make start [PORT=3000] [LOG=info] [MONGO_URL=…]
	@$(RUN_ENV) cd hub && NODE_ENV=production node dist/index.js

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

agent: ## Compile l'agent (amd64 + arm64, agent/dist) ; version agent/VERSION, build +1 si les sources ont changé
	@./agent/build.sh

agent-minor: ## Version mineure de l'agent +1 (X.Y+1.0), puis compile
	@./agent/build.sh minor

agent-major: ## Version majeure de l'agent +1 (X+1.0.0), puis compile
	@./agent/build.sh major

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
	cd hub && npm run typecheck
	cd web && npm run lint

test: ## Tests unitaires (agent + hub)
	cd agent && go test ./...
	cd hub && npm test

build: agent ## Build complet : agent (amd64 + arm64), hub, interface
	cd hub && npm run build
	cd web && npm run build

check: lint test build ## Tout ce que lance la CI : lint + tests + build

clean: ## Supprime les artefacts de build
	rm -rf agent/dist hub/dist web/dist

# --- Docker ----------------------------------------------------------------------

release-key: ## Crée la clé de signature des agents (une fois) : clé privée dans RELEASE_KEY, agent/release.pub à commiter
	cd agent && go run ./cmd/hm-sign keygen -key $(RELEASE_KEY) -pub release.pub
	@echo "Clé privée : $(RELEASE_KEY) (à sauvegarder, jamais dans le dépôt)"
	@echo "Clé publique : agent/release.pub (à commiter : les agents de release l'embarquent)"

docker-build: ## Construit l'image locale homelab-manager:latest (sans push ; agents signés si la clé de release est présente)
	bash docker-release.sh build

docker-release: check ## Release : build +1 (X.Y.Z+1), commit, build et push Docker Hub (amd64 + arm64), tag git
	bash docker-release.sh release

docker-release-minor: check ## Release : mineur +1, build remis à 0 (X.Y+1.0), commit, build et push, tag git
	bash docker-release.sh release-minor

docker-release-major: check ## Release : majeur +1, mineur et build à 0 (X+1.0.0), commit, build et push, tag git
	bash docker-release.sh release-major

docker-direct: check ## Contournement de Docker Hub : build amd64, image transférée par ssh au hub (CT 171) et service recréé [YES=1] [DIRECT_SSH=… DIRECT_PCT=… DIRECT_DIR=…]
	YES=$(YES) bash docker-release.sh direct
