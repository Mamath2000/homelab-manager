#!/bin/bash
# Build / release Docker de homelab-manager.
#   build         : image locale homelab-manager:latest pour l'architecture courante (aucun push)
#   release       : build +1 (X.Y.Z → X.Y.Z+1 : VERSION, hub/ et web/package.json) commitée « Release X.Y.Z »,
#                   build multi-arch et push Docker Hub (latest, X.Y.Z, ref git), tag git vX.Y.Z
#                   — l'image X.Y.Z contient exactement ce commit
#   release-minor : mineur +1, build remis à 0 (X.Y+1.0)
#   release-major : majeur +1, mineur et build remis à 0 (X+1.0.0)
# Variables : DOCKER_USER (défaut mathmath350), PLATFORMS (défaut linux/amd64,linux/arm64)
set -e
cd "$(dirname "$0")"

APP_NAME="homelab-manager"
DOCKER_USER=${DOCKER_USER:-"mathmath350"}
PLATFORMS=${PLATFORMS:-"linux/amd64,linux/arm64"}
BUILDER="homelab-manager-builder"
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

for cmd in docker git npm; do
    command -v $cmd >/dev/null 2>&1 || { echo "❌ $cmd est requis mais non installé."; exit 1; }
done

VERSION=$(cat VERSION)

if [ "$action" = "build" ]; then
    docker build --build-arg VERSION="$VERSION-dev" -t "$APP_NAME:latest" .
    echo "✅ Image locale $APP_NAME:latest construite (aucun push)"
    exit 0
fi

case "$action" in
    release|release-minor|release-major) ;;
    *) echo "Usage: $0 [build|release|release-minor|release-major]"; exit 1 ;;
esac

docker buildx version >/dev/null 2>&1 || { echo "❌ docker buildx est requis."; exit 1; }
docker info 2>/dev/null | grep -q Username || { echo "❌ Non connecté à Docker Hub (docker login)."; exit 1; }
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
    --build-arg VERSION="$NEW_VERSION" \
    --label "org.opencontainers.image.version=$NEW_VERSION" \
    --label "org.opencontainers.image.revision=$GIT_REF" \
    --label "org.opencontainers.image.created=$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    --label "org.opencontainers.image.source=https://github.com/Mamath2000/homelab-manager" \
    -t "$DOCKER_USER/$APP_NAME:latest" \
    -t "$DOCKER_USER/$APP_NAME:$NEW_VERSION" \
    -t "$DOCKER_USER/$APP_NAME:$GIT_REF" \
    --push \
    .
git tag "v$NEW_VERSION"

echo "✅ Version $NEW_VERSION publiée : $DOCKER_USER/$APP_NAME:{latest,$NEW_VERSION,$GIT_REF} ($PLATFORMS)"
echo "🔄 À pousser : git push origin $(git rev-parse --abbrev-ref HEAD) --tags"
