# Makefile pour homelab-manager — `make` ou `make help` liste les commandes
.PHONY: help install dev start stop agent agent-minor agent-major agent-run build lint fmt test check clean version \
        mongo mongo-stop docker-build docker-up docker-down docker-logs \
        docker-release docker-release-minor docker-release-major
.DEFAULT_GOAL := help

VERSION   := $(shell cat VERSION)
# Port du hub : HUB_PORT de la ligne de commande, de l'environnement, sinon de .env, sinon 3000.
# Seule source du port : publié par docker compose, écouté par make dev / make start (PORT), visé par Vite et agent-run.
ifndef HUB_PORT
HUB_PORT  := $(shell set -a; [ -f .env ] && . ./.env; echo $${HUB_PORT:-3000})
endif
HUB       ?= http://localhost:$(HUB_PORT)
LOAD_ENV  := set -a; [ -f .env ] && . ./.env; set +a; export PORT=$(HUB_PORT) HUB_URL=$(HUB);

help: ## Affiche cette aide
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[32m%-22s\033[0m %s\n", $$1, $$2}'

version: ## Affiche la version courante
	@echo $(VERSION)

# --- Installation et développement -------------------------------------------

install: ## Installe les dépendances (npm ci hub + web, go mod download)
	cd hub && npm ci
	cd web && npm ci
	cd agent && go mod download

mongo: ## MongoDB de dev : réutilise celui qui écoute déjà sur 27017 (dev-math), sinon lance le conteneur homelab-mongo
	@if nc -z localhost 27017 2>/dev/null; then \
		echo "MongoDB déjà actif sur localhost:27017 : réutilisé"; \
	else \
		docker start homelab-mongo >/dev/null 2>&1 || \
			docker run -d --name homelab-mongo -p 27017:27017 -v homelab-mongo:/data/db mongo:7 >/dev/null; \
	fi
	@echo "MongoDB : mongodb://localhost:27017/homelab"

mongo-stop: ## Arrête le conteneur homelab-mongo s'il a été lancé par make mongo (jamais un MongoDB partagé)
	@if docker ps -q --filter name='^homelab-mongo$$' | grep -q .; then docker stop homelab-mongo; \
	else echo "homelab-mongo non lancé : rien à arrêter"; fi

dev: agent ## Lance hub (rechargement auto) + interface Vite sur http://localhost:5173 ; Ctrl-C arrête tout
	@echo "hub : $(HUB)   ·   interface : http://localhost:5173"
	@$(LOAD_ENV) trap 'trap - INT TERM; kill 0' INT TERM; \
		(cd hub && npm run dev) & \
		(cd web && npm run dev) & \
		wait

start: build ## Build complet puis lance le hub comme en production (UI servie sur le port HUB_PORT)
	@$(LOAD_ENV) cd hub && NODE_ENV=production node dist/index.js

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

agent-run: ## Lance l'agent en local contre le hub : make agent-run TOKEN=<token> [HUB=url] (root pour apt-get)
	@[ -n "$(TOKEN)" ] || { echo "Usage : make agent-run TOKEN=<token> [HUB=$(HUB)]"; exit 1; }
	cd agent && go run -ldflags "-X main.version=$$(cat VERSION)-dev" . -hub $(HUB) -token $(TOKEN)

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

docker-build: ## Construit l'image locale homelab-manager:latest (sans push)
	bash docker-release.sh build

docker-up: ## Lance hub + mongo avec l'image locale (après make docker-build), sur le port HUB_PORT
	HUB_IMAGE=homelab-manager:latest docker compose up -d
	@echo "http://localhost:$(HUB_PORT)"

docker-down: ## Arrête la stack docker compose
	docker compose down

docker-logs: ## Suit les logs de la stack docker compose
	docker compose logs -f

docker-release: check ## Release : build +1 (X.Y.Z+1), commit, build et push Docker Hub (amd64 + arm64), tag git
	bash docker-release.sh release

docker-release-minor: check ## Release : mineur +1, build remis à 0 (X.Y+1.0), commit, build et push, tag git
	bash docker-release.sh release-minor

docker-release-major: check ## Release : majeur +1, mineur et build à 0 (X+1.0.0), commit, build et push, tag git
	bash docker-release.sh release-major
