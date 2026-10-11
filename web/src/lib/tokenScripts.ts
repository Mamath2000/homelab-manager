// Blocks to paste in a root shell of the PBS / PVE: they create the user and its token, give the
// role to both, and end by printing the token id and secret to copy into the form. Safe to paste
// again: an existing user is kept, an existing token is never replaced silently (its secret cannot
// be read back). The creation commands do not take --output-format: the secret (a UUID) is taken
// from their plain output. Run in a subshell so that `set -e` does not close the shell it is pasted in; the
// '!' of the token id stays in single quotes (history expansion of interactive bash).

// path: "{store}" is replaced by each datastore of the PBS (the same rights on all of them).
export function pbsTokenScript(o: { user: string; token: string; path: string; role: string }) {
  const paths = o.path.includes('{store}')
    ? `$(proxmox-backup-manager datastore list --output-format json | jq -r --arg a '${o.path}' '.[].name | . as $s | $a | sub("{store}"; $s)')`
    : `'${o.path}'`;
  return `(
set -e
command -v proxmox-backup-manager >/dev/null || { echo "À coller sur le serveur PBS : proxmox-backup-manager est introuvable ici."; exit 1; }
U='${o.user}'; T='${o.token}'; ID='${o.user}!${o.token}'
proxmox-backup-manager user list --output-format json | jq -e --arg u "$U" 'any(.[]; .userid == $u)' >/dev/null \\
  || proxmox-backup-manager user create "$U"
J=
proxmox-backup-manager user list-tokens "$U" --output-format json | jq -e --arg t "$T" 'any(.[]; .tokenid == $t or (.tokenid | endswith("!" + $t)))' >/dev/null \\
  || J=$(proxmox-backup-manager user generate-token "$U" "$T")
# droits de l'utilisateur ET du jeton (intersection)
for P in ${paths}; do
  proxmox-backup-manager acl update "$P" ${o.role} --auth-id "$U"
  proxmox-backup-manager acl update "$P" ${o.role} --auth-id "$ID"
  echo "${o.role} sur $P"
done
echo
echo "Identifiant du jeton : $ID"
if [ -z "$J" ]; then echo "Jeton existant conservé (droits mis à jour) : son secret n'est plus lisible."; exit 0; fi
# the secret is a UUID, whatever the output format of the command
S=$(printf '%s\\n' "$J" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -n 1)
if [ -n "$S" ]; then echo "Secret du jeton      : $S"; else echo "Secret du jeton : à relever dans la sortie ci-dessous"; printf '%s\\n' "$J"; fi
)`;
}

export function pveTokenScript(o: { user: string; token: string; path: string; role: string }) {
  return `(
set -e
command -v pveum >/dev/null || { echo "À coller sur un nœud du cluster Proxmox VE : pveum est introuvable ici."; exit 1; }
U='${o.user}'; T='${o.token}'; ID='${o.user}!${o.token}'
pveum user list --output-format json | jq -e --arg u "$U" 'any(.[]; .userid == $u)' >/dev/null \\
  || pveum user add "$U"
if pveum user token list "$U" --output-format json | jq -e --arg t "$T" 'any(.[]; .tokenid == $t)' >/dev/null; then
  echo "Le jeton $ID existe déjà et son secret n'est plus lisible. Pour le remplacer : pveum user token remove $U $T, puis recoller ce bloc."
  exit 1
fi
J=$(pveum user token add "$U" "$T" --privsep 1)
# droits de l'utilisateur ET du jeton (séparation des privilèges)
pveum acl modify '${o.path}' --roles ${o.role} --users "$U"
pveum acl modify '${o.path}' --roles ${o.role} --tokens "$ID"
echo
echo "Identifiant du jeton : $ID"
# the secret is a UUID, whatever the output format of the command
S=$(printf '%s\n' "$J" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -n 1)
if [ -n "$S" ]; then echo "Secret du jeton      : $S"; else echo "Secret du jeton : à relever dans la sortie ci-dessous"; printf '%s\n' "$J"; fi
)`;
}
