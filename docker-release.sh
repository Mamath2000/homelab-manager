#!/bin/bash
# Build / release Docker de homelab-manager.
#   build         : image locale homelab-manager:latest pour l'architecture courante (aucun push)
#   release       : build +1 (X.Y.Z → X.Y.Z+1 : VERSION, hub/ et web/package.json) commitée « Release X.Y.Z »,
#                   build multi-arch et push Docker Hub (latest, X.Y.Z, ref git), tag git vX.Y.Z
#                   — l'image X.Y.Z contient exactement ce commit ; commit et tags poussés, puis synchro de
#                   l'application HAOS lancée (gh workflow run, homelab-manager-haos)
#   release-minor : mineur +1, build remis à 0 (X.Y+1.0)
#   release-major : majeur +1, mineur et build remis à 0 (X+1.0.0)
#   prune         : libère le disque : agent/hub/web dist, anciennes images locales de homelab-manager et
#                   homelab-agent-haos (reste latest et la version courante), images orphelines, cache buildx > 7 j
#                   (proposé aussi en fin de release, avec confirmation ; YES=1 l'accepte d'office)
#   direct        : contournement de Docker Hub : build amd64 sans identifiants (config Docker vide), image
#                   transférée par ssh dans le CT du hub (docker save | docker load), puis compose up du service.
#                   Rien n'est publié ni commité ; tags locaux latest et X.Y.Z-<ref git>.
#                   Variables : DIRECT_SSH (pve1.lo), DIRECT_PCT (171, vide = hôte ssh lui-même),
#                   DIRECT_DIR (/home/mamath/homelab-manager), DIRECT_SERVICE (hub), YES=1 (sans confirmation)
# Les binaires de l'agent sont signés avec la clé de release (make release-key), passée en secret BuildKit :
# obligatoire pour une release, facultative pour build (sans elle : agents de développement non signés).
# Variables : DOCKER_USER (défaut mathmath350), PLATFORMS (défaut linux/amd64,linux/arm64),
#             RELEASE_KEY (défaut ~/.config/homelab-manager/release.key)
set -e
cd "$(dirname "$0")"

APP_NAME="homelab-manager"
DOCKER_USER=${DOCKER_USER:-"mathmath350"}
PLATFORMS=${PLATFORMS:-"linux/amd64,linux/arm64"}
BUILDER="homelab-manager-builder"
HAOS_REPO="Mamath2000/homelab-manager-haos"   # Home Assistant OS app, follows the agent of each release
action=${1:-build}

# next_version X.Y.Z (release|release-minor|release-major) : le build est incrémenté automatiquement
next_version() {
    local major minor patch
    IFS='.' read -r major minor patch <<< "$1"
    case "$2" in
        release-major) echo "$((major + 1)).0.0" ;;
        release-minor) echo "$major.$((minor + 1)).0" ;;
        *) echo "$major.$minor.$((patch + 1))" ;;
    esac
}

# prune_old : supprime les anciens artefacts de build (les erreurs sont ignorées : image en cours d'utilisation…)
prune_old() {
    echo "🧹 Nettoyage des anciens artefacts de build"
    rm -rf agent/dist hub/dist web/dist
    local keep
    keep=$(cat VERSION)
    docker images --format '{{.Repository}}:{{.Tag}}' \
        | grep -E "^($DOCKER_USER/$APP_NAME|$APP_NAME|homelab-agent-haos)(:|$)" \
        | grep -Ev ":(latest|local|$keep|$keep-[0-9a-f]+)$" \
        | xargs -r docker rmi 2>/dev/null || true
    docker image prune -f >/dev/null 2>&1 || true
    docker buildx prune -f --filter until=168h >/dev/null 2>&1 || true
    docker buildx prune -f --builder "$BUILDER" --filter until=168h >/dev/null 2>&1 || true
    docker system df
}

# ask_prune : fin de release, nettoyage après confirmation (sans terminal et sans YES=1 : ignoré)
ask_prune() {
    if [ "${YES:-}" != "1" ]; then
        [ -t 0 ] || { echo "⏸️  Nettoyage non lancé (pas de terminal) : bash docker-release.sh prune"; return 0; }
        read -r -p "Nettoyer les anciens artefacts de build (dist, anciennes images, cache buildx) ? [o/N] " answer
        case "$answer" in o|O|oui|y|Y) ;; *) echo "⏸️  Nettoyage ignoré (bash docker-release.sh prune)"; return 0 ;; esac
    fi
    prune_old
}

for cmd in docker git npm; do
    command -v $cmd >/dev/null 2>&1 || { echo "❌ $cmd est requis mais non installé."; exit 1; }
done

# agent/VERSION est incrémenté par `make check` (agent/build.sh) quand les sources de l'agent ont changé :
# s'il est le seul fichier modifié, il est commité à part avant le contrôle de propreté.
commit_agent_version() {
    [ "$(git status --porcelain)" = " M agent/VERSION" ] || return 0
    git add agent/VERSION
    git commit -q -m "🔖 Agent $(cat agent/VERSION)"
    echo "📌 agent/VERSION commité ($(cat agent/VERSION))"
}

VERSION=$(cat VERSION)
RELEASE_KEY=${RELEASE_KEY:-"$HOME/.config/homelab-manager/release.key"}

# Arguments de build pour signer les binaires de l'agent, après vérification de la clé.
signing_args() {
    [ -f "$RELEASE_KEY" ] && [ -f agent/release.pub ] || return 1
    local pub
    pub=$(cat agent/release.pub)
    [ "$(cd agent && go run ./cmd/hm-sign pub -key "$RELEASE_KEY")" = "$pub" ] || {
        echo "❌ $RELEASE_KEY ne correspond pas à agent/release.pub" >&2
        exit 1
    }
    SIGNING=(--secret "id=release_key,src=$RELEASE_KEY" --build-arg "RELEASE_PUB=$pub")
}

if [ "$action" = "prune" ]; then
    prune_old
    exit 0
fi

if [ "$action" = "build" ]; then
    SIGNING=()
    signing_args || echo "⚠️  Pas de clé de release ($RELEASE_KEY) : agents de développement non signés"
    docker build "${SIGNING[@]}" -t "$APP_NAME:latest" .
    echo "✅ Image locale $APP_NAME:latest construite (aucun push)"
    exit 0
fi

if [ "$action" = "direct" ]; then
    DIRECT_SSH=${DIRECT_SSH:-"pve1.lo"}
    DIRECT_PCT=${DIRECT_PCT-"171"}
    DIRECT_DIR=${DIRECT_DIR:-"/home/mamath/homelab-manager"}
    DIRECT_SERVICE=${DIRECT_SERVICE:-"hub"}
    # commande exécutée sur la cible : dans le CT via pct exec, sinon sur l'hôte ssh
    remote() {
        if [ -n "$DIRECT_PCT" ]; then ssh "$DIRECT_SSH" "pct exec $DIRECT_PCT -- sh -c '$1'"
        else ssh "$DIRECT_SSH" "sh -c '$1'"; fi
    }
    command -v go >/dev/null 2>&1 || { echo "❌ go est requis (vérification de la clé de release)."; exit 1; }
    signing_args || { echo "❌ Clé de release absente ($RELEASE_KEY) : les agents de production doivent être signés."; exit 1; }
    commit_agent_version
    if [ -n "$(git status --porcelain)" ]; then
        echo "❌ Working directory non propre, commitez d'abord (l'image doit correspondre à un commit) :"
        git status --short
        exit 1
    fi
    GIT_REF=$(git rev-parse --short HEAD)
    IMAGE="$DOCKER_USER/$APP_NAME"
    TAG="$VERSION-$GIT_REF"
    TARGET="$DIRECT_SSH${DIRECT_PCT:+ / CT $DIRECT_PCT}:$DIRECT_DIR (service $DIRECT_SERVICE)"

    # config Docker vide : buildkit tire les images de base en anonyme, sans la session Docker Hub
    DOCKER_CONFIG=$(mktemp -d)
    export DOCKER_CONFIG
    trap 'rm -rf "$DOCKER_CONFIG"' EXIT
    echo "🔨 Build $IMAGE:$TAG (linux/amd64, sans identifiants Docker Hub)"
    docker buildx build \
        --builder default \
        --platform linux/amd64 \
        --label "org.opencontainers.image.version=$VERSION" \
        --label "org.opencontainers.image.revision=$GIT_REF" \
        --label "org.opencontainers.image.created=$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
        --label "org.opencontainers.image.source=https://github.com/Mamath2000/homelab-manager" \
        -t "$IMAGE:latest" \
        -t "$IMAGE:$TAG" \
        "${SIGNING[@]}" \
        --load \
        .

    echo "📤 Transfert vers $TARGET"
    docker save "$IMAGE:latest" "$IMAGE:$TAG" | gzip -1 | remote "gunzip | docker load"

    if [ "${YES:-}" != "1" ]; then
        read -r -p "Recréer le service $DIRECT_SERVICE sur $TARGET avec $IMAGE:$TAG ? [o/N] " answer
        case "$answer" in o|O|oui|y|Y) ;; *) echo "⏸️  Image chargée, service non redémarré (docker compose up -d $DIRECT_SERVICE dans $DIRECT_DIR)"; exit 0 ;; esac
    fi
    # pas de pull : compose prend l'image latest chargée localement
    remote "cd $DIRECT_DIR && docker compose up -d --pull never $DIRECT_SERVICE"
    sleep 5
    remote "cd $DIRECT_DIR && docker compose ps $DIRECT_SERVICE"
    # le conteneur doit tourner sur ce commit (label de révision ; les ID d'image changent selon le stockage)
    labels=$(remote "docker inspect --format {{.Config.Labels}} \$(cd $DIRECT_DIR && docker compose ps -q $DIRECT_SERVICE)")
    case "$labels" in *"org.opencontainers.image.revision:$GIT_REF"*) ;; *) echo "❌ Le conteneur ne tourne pas sur $IMAGE:$TAG"; exit 1 ;; esac
    echo "✅ $IMAGE:$TAG déployée sur $TARGET (non publiée sur Docker Hub)"
    echo "⚠️  Un docker compose pull / make apps-redeploy repasserait sur la latest de Docker Hub : faire la release Docker Hub dès que possible."
    exit 0
fi

case "$action" in
    release|release-minor|release-major) ;;
    *) echo "Usage: $0 [build|prune|release|release-minor|release-major|direct]"; exit 1 ;;
esac

command -v go >/dev/null 2>&1 || { echo "❌ go est requis (vérification de la clé de release)."; exit 1; }
signing_args || {
    echo "❌ Clé de release absente : $RELEASE_KEY et agent/release.pub sont requis pour signer les agents."
    echo "   Première fois : make release-key, puis commite agent/release.pub (et sauvegarde la clé privée)."
    exit 1
}
docker buildx version >/dev/null 2>&1 || { echo "❌ docker buildx est requis."; exit 1; }
docker info 2>/dev/null | grep -q Username || { echo "❌ Non connecté à Docker Hub (docker login)."; exit 1; }
commit_agent_version
if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Working directory non propre, commitez d'abord :"
    git status --short
    exit 1
fi

NEW_VERSION=$(next_version "$VERSION" "$action")
echo "📦 Version : $VERSION → $NEW_VERSION"

VERSION_FILES="VERSION hub/package.json hub/package-lock.json web/package.json web/package-lock.json"
trap 'echo "❌ Échec : version restaurée"; git checkout -- $VERSION_FILES' ERR
echo "$NEW_VERSION" > VERSION
for dir in hub web; do
    (cd "$dir" && npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null)
done
git add $VERSION_FILES
git commit -q -m "🔖 Release $NEW_VERSION"
trap - ERR
trap 'echo "❌ Échec du build/push : annuler le commit de release avec  git reset --hard HEAD~1"' ERR
GIT_REF=$(git rev-parse --short HEAD)

# Un builder docker-container sait produire et pousser une image multi-arch.
# Le Dockerfile compile tout sur la plateforme de build : pas besoin de QEMU.
docker buildx inspect "$BUILDER" >/dev/null 2>&1 || docker buildx create --name "$BUILDER" --driver docker-container >/dev/null

docker buildx build \
    --builder "$BUILDER" \
    --platform "$PLATFORMS" \
    --label "org.opencontainers.image.version=$NEW_VERSION" \
    --label "org.opencontainers.image.revision=$GIT_REF" \
    --label "org.opencontainers.image.created=$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    --label "org.opencontainers.image.source=https://github.com/Mamath2000/homelab-manager" \
    -t "$DOCKER_USER/$APP_NAME:latest" \
    -t "$DOCKER_USER/$APP_NAME:$NEW_VERSION" \
    -t "$DOCKER_USER/$APP_NAME:$GIT_REF" \
    "${SIGNING[@]}" \
    --push \
    .
git tag "v$NEW_VERSION"

echo "✅ Version $NEW_VERSION publiée : $DOCKER_USER/$APP_NAME:{latest,$NEW_VERSION,$GIT_REF} ($PLATFORMS)"
trap - ERR

# The image is out: the release commit and its tag go to GitHub, then the HAOS app checks the agent
# it ships (rebuilt only when agent/VERSION changed). Failures here leave the release as it is.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push -q origin "$BRANCH" --tags \
    && echo "✅ Poussé : $BRANCH et tag v$NEW_VERSION" \
    || echo "⚠️  Push échoué : git push origin $BRANCH --tags"
gh workflow run sync.yaml -R "$HAOS_REPO" \
    && echo "✅ Synchro de l'application HAOS lancée : gh run list -R $HAOS_REPO" \
    || echo "⚠️  Synchro HAOS non lancée : make -C ../homelab-manager-haos sync (sinon cron quotidien)"
ask_prune
