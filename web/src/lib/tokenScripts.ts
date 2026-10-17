// Block to paste in a root shell of a PVE node (the tokens of a PBS are created by its agent): it
// creates the user and its token, gives the role to both, and ends by printing the token id and secret
// to copy into the form. Safe to paste again: an existing user is kept, an existing token is never
// replaced silently (its secret cannot be read back). The creation command does not take
// --output-format: the secret (a UUID) is taken from its plain output. Run in a subshell so that
// `set -e` does not close the shell it is pasted in; the '!' of the token id stays in single quotes
// (history expansion of interactive bash).

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

// "user@realm!name" -> its user and token name (for the manual blocks); fallback when malformed
export function splitTokenId(id: string, fallbackUser: string, fallbackToken: string) {
  const i = id.indexOf('!');
  return i > 0 ? { user: id.slice(0, i), token: id.slice(i + 1) || fallbackToken } : { user: fallbackUser, token: fallbackToken };
}
