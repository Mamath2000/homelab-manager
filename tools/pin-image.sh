#!/bin/sh
# Épingle l'image du hub par son empreinte dans le compose de prod : `image: mathmath350/homelab-manager:dev@sha256:…`
# (Docker utilise l'empreinte, le tag reste là pour être lu). Lancé sur le CT, dans le dossier du compose, par `make publish` :
#   sh -s -- sha256:<empreinte> < tools/pin-image.sh
# La ligne doit exister une seule fois ; sinon rien n'est modifié et le script échoue (publish s'arrête avant le pull).
# Une copie du fichier d'avant est gardée dans docker-compose.yml.bak (retour arrière : la remettre en place).
set -eu

digest=${1:-}
file=${COMPOSE_FILE:-docker-compose.yml}
case "$digest" in
  sha256:*) ;;
  *) echo "pin-image : empreinte attendue (sha256:…), reçu « $digest »" >&2; exit 1 ;;
esac
printf '%s' "${digest#sha256:}" | grep -Eq '^[0-9a-f]{64}$' || { echo "pin-image : empreinte invalide" >&2; exit 1; }

pattern='^( *image: *mathmath350/homelab-manager):dev(@sha256:[0-9a-f]{64})?( *#.*)?$'
[ "$(grep -Ec "$pattern" "$file")" = 1 ] || { echo "pin-image : ligne image du hub absente ou multiple dans $file, rien modifié" >&2; exit 1; }

cp "$file" "$file.bak"
sed -i -E "s|$pattern|\\1:dev@$digest\\3|" "$file"
grep -E 'image: *mathmath350/homelab-manager' "$file"
