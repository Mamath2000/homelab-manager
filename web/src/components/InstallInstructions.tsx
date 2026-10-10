import { useState } from 'react';
import type { InstallInfo } from '../lib/api';
import { dateTime } from '../lib/format';
import { CopyField } from './ui';

// Same rule as install.sh: absolute path, no space or shell character.
const DIR_RE = /^\/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$/;

export function InstallInstructions({ install }: { install: InstallInfo }) {
  const [dir, setDir] = useState('');
  const dirOk = !dir || DIR_RE.test(dir);
  const command = install.installCommand && `${install.installCommand}${dir && dirOk ? ` --dir ${dir.replace(/\/+$/, '')}` : ''}`;
  return (
    <div className="space-y-4 text-sm">
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Répertoire d'installation (optionnel)</span>
        <input className="input" value={dir} onChange={(e) => setDir(e.target.value.trim())} placeholder="/opt/homelab-agent" spellCheck={false} />
        <span className={dirOk ? 'mt-1 block text-xs text-zinc-500' : 'mt-1 block text-xs text-red-400'}>
          {dirOk
            ? "Vide : emplacements standard (Debian / Ubuntu), ou la clé USB sur Unraid. Sinon, binaire, configuration, certificat et état de l'agent vont dans ce répertoire."
            : 'Chemin absolu, avec seulement des lettres, chiffres et . _ - /'}
        </span>
      </label>
      <div>
        <p className="mb-2 text-zinc-300">
          Lance cette commande <strong className="text-zinc-100">en root</strong> sur l'hôte (Debian / Ubuntu avec systemd, WSL2 compris, ou Unraid ; curl requis) :
        </p>
        {command ? (
          <CopyField value={command} multiline />
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
