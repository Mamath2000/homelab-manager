#!/usr/bin/env bash
# Regenerates the golden lists of the estimate conformance test with the real PBS client:
# builds tree.txt on a host that has pxar (package proxmox-backup-client), archives it once per
# case of cases.txt with its --exclude patterns, and writes the archived paths (pxar list) to
# golden/<case>.txt. Nothing is uploaded: the archives are local files, removed at the end.
#   agent/testdata/estimate/regen.sh [ssh host, default pve1.lo]
set -euo pipefail
cd "$(dirname "$0")"
HOST=${1:-pve1.lo}

remote=$(cat <<'SH'
set -euo pipefail
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
cd "$W"
tar xf - tree.txt cases.txt
mkdir t
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  kind=${line%% *}; rest=${line#* }
  case $kind in
    f) mkdir -p "t/$(dirname "$rest")"; printf '%s' "$rest" > "t/$rest" ;;
    d) mkdir -p "t/$rest" ;;
    x) p=${rest%% *}; mkdir -p "t/$(dirname "$p")"; printf '%b' "${rest#* }" > "t/$p" ;;
  esac
done < tree.txt
echo "== version $(pxar --version 2>/dev/null || proxmox-backup-client version | head -1)"
while IFS=$'\t' read -r -a f; do
  [[ ${#f[@]} -eq 0 || "${f[0]}" == \#* ]] && continue
  args=()
  for p in "${f[@]:1}"; do args+=(--exclude "$p"); done
  pxar create "${f[0]}.pxar" t "${args[@]}" >/dev/null 2>&1
  echo "== ${f[0]}"
  pxar list "${f[0]}.pxar"
done < cases.txt
SH
)

out=$(tar cf - tree.txt cases.txt | ssh -o BatchMode=yes "$HOST" "bash -c $(printf '%q' "$remote")")
rm -f golden/*.txt
name=""
while IFS= read -r line; do
  if [[ "$line" == "== version "* ]]; then
    echo "client: ${line#== version }"
  elif [[ "$line" == "== "* ]]; then
    name=${line#== }
    : > "golden/$name.txt"
  elif [[ -n "$name" ]]; then
    # "/path" as printed by pxar list; the root and the .pxarexclude-cli of the client left out
    line=${line#\"}; line=${line%\"}
    [[ "$line" == "/" || "$line" == "/.pxarexclude-cli" ]] && continue
    printf '%s\n' "$line" >> "golden/$name.txt"
  fi
done <<< "$out"
for f in golden/*.txt; do LC_ALL=C sort -o "$f" "$f"; done
echo "$(ls golden | wc -l) golden lists written from $HOST"
