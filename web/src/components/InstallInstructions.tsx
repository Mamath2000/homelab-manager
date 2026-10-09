import type { InstallInfo } from '../lib/api';
import { dateTime } from '../lib/format';
import { CopyField } from './ui';

export function InstallInstructions({ install }: { install: InstallInfo }) {
  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="mb-2 text-zinc-300">
          Lance cette commande <strong className="text-zinc-100">en root</strong> sur l'hôte (Debian / Ubuntu, systemd, curl) :
        </p>
        {install.installCommand ? (
          <CopyField value={install.installCommand} multiline />
        ) : (
          <p className="text-red-400">URL du hub invalide : corrige « URL du hub » dans les paramètres.</p>
        )}
      </div>
      <ul className="list-inside list-disc space-y-1 text-xs text-muted">
        <li>
          Code à usage unique, valable jusqu'au <span className="text-zinc-300">{dateTime(install.expiresAt)}</span>. Il n'est affiché qu'une fois :
          au besoin, génère une nouvelle commande depuis la fiche de l'hôte (l'ancienne cesse alors de fonctionner).
        </li>
        <li>
          La commande épingle la clé du hub (<code className="text-zinc-300">--pinnedpubkey</code>) : elle échoue si un autre serveur répond à sa place.
        </li>
        <li>
          L'agent crée sa clé privée sur l'hôte, reçoit un certificat du hub, puis ouvre une connexion sortante chiffrée : aucun port à ouvrir sur l'hôte.
        </li>
      </ul>
    </div>
  );
}
