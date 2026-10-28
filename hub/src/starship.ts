// Default Starship configuration of the prompt (Paramètres > Standardisation), written by the agent to
// /etc/homelab/starship.toml: user@host: then the directory on the next line. username and hostname
// get their own format, the default one ends with " in ".
export const DEFAULT_STARSHIP = `format = "$username@$hostname:$line_break$directory$character"

[username]
show_always = true
style_user = "bold green"
format = "[$user]($style)"

[hostname]
ssh_only = false
style = "bold bright-red"
format = "[$ssh_symbol$hostname]($style)"

[directory]
style = "bold cyan"
truncation_length = 3
`;
