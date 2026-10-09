import { CopyField } from './ui';

export function InstallInstructions({ command }: { command: string | null }) {
  const origin = window.location.origin;
  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="mb-2 text-zinc-300">
          Lance cette commande <strong className="text-zinc-100">en root</strong> sur l'hôte (Debian / Ubuntu, systemd) :
        </p>
        {command ? <CopyField value={command} multiline /> : <p className="text-red-400">URL du hub invalide : définis PUBLIC_URL.</p>}
      </div>
      <ul className="list-inside list-disc space-y-1 text-xs text-muted">
        <li>
          Le token n'est affiché qu'une fois. Sans lui, régénère-en un depuis la fiche de l'hôte.
        </li>
        <li>L'agent ouvre une connexion sortante vers le hub : aucun port à ouvrir sur l'hôte.</li>
        <li>
          Mise à jour de l'agent (token conservé) : <code className="text-zinc-300">curl -fsSL {origin}/install.sh | sh</code>
        </li>
      </ul>
    </div>
  );
}
