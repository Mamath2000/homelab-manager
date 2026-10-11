// Blocks to paste in a root shell of the PBS / PVE: they create the user and its token, give the
// role to both, and end by printing the token id and secret to copy into the form. Safe to paste
// again: an existing user is kept, an existing token is never replaced silently (its secret cannot
// be read back). Run in a subshell so that `set -e` does not close the shell it is pasted in; the
// '!' of the token id stays in single quotes (history expansion of interactive bash).

export function pbsTokenScript(o: { user: string; token: string; path: string; role: string }) {
  return `(
set -e
U='${o.user}'; T='${o.token}'; ID='${o.user}!${o.token}'
proxmox-backup-manager user list --output-format json | jq -e --arg u "$U" 'any(.[]; .userid == $u)' >/dev/null \\
  || proxmox-backup-manager user create "$U"
if proxmox-backup-manager user list-tokens "$U" --output-format json | jq -e --arg t "$T" 'any(.[]; .tokenid == $t or (.tokenid | endswith("!" + $t)))' >/dev/null; then
  echo "Le jeton $ID existe déjà et son secret n'est plus lisible. Pour le remplacer : proxmox-backup-manager user delete-token $U $T, puis recoller ce bloc."
  exit 1
fi
J=$(proxmox-backup-manager user generate-token "$U" "$T" --output-format json)
# droits de l'utilisateur ET du jeton (intersection)
proxmox-backup-manager acl update '${o.path}' ${o.role} --auth-id "$U"
proxmox-backup-manager acl update '${o.path}' ${o.role} --auth-id "$ID"
echo
echo "Identifiant du jeton : $ID"
echo "Secret du jeton      : $(echo "$J" | jq -r .value)"
)`;
}

export function pveTokenScript(o: { user: string; token: string; path: string; role: string }) {
  return `(
set -e
U='${o.user}'; T='${o.token}'; ID='${o.user}!${o.token}'
pveum user list --output-format json | jq -e --arg u "$U" 'any(.[]; .userid == $u)' >/dev/null \\
  || pveum user add "$U"
if pveum user token list "$U" --output-format json | jq -e --arg t "$T" 'any(.[]; .tokenid == $t)' >/dev/null; then
  echo "Le jeton $ID existe déjà et son secret n'est plus lisible. Pour le remplacer : pveum user token remove $U $T, puis recoller ce bloc."
  exit 1
fi
J=$(pveum user token add "$U" "$T" --privsep 1 --output-format json)
# droits de l'utilisateur ET du jeton (séparation des privilèges)
pveum acl modify '${o.path}' --roles ${o.role} --users "$U"
pveum acl modify '${o.path}' --roles ${o.role} --tokens "$ID"
echo
echo "Identifiant du jeton : $ID"
echo "Secret du jeton      : $(echo "$J" | jq -r .value)"
)`;
}
