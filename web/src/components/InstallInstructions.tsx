import { useState } from 'react';
import { Home, Terminal } from 'lucide-react';
import type { InstallInfo } from '../lib/api';
import { dateTime } from '../lib/format';
import { CopyField, Tabs } from './ui';

// Add-on repository of the agent for Home Assistant OS (Settings > Add-ons > Add-on store > Repositories)
export const HAOS_ADDON_REPO = 'https://github.com/Mamath2000/homelab-manager-haos';

// Same rule as install.sh: absolute path, no space or shell character.
const DIR_RE = /^\/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$/;

export function InstallInstructions({ install }: { install: InstallInfo }) {
  const [platform, setPlatform] = useState<'linux' | 'haos'>('linux');
  return (
    <div className="text-sm">
      <Tabs
        tabs={[
          { id: 'linux', label: 'Linux / Unraid', icon: Terminal },
          { id: 'haos', label: 'Home Assistant OS', icon: Home },
        ]}
        value={platform}
        onChange={setPlatform}
      />
      {platform === 'linux' ? <LinuxInstall install={install} /> : <HaosInstall install={install} />}
    </div>
  );
}

function CodeValidity({ install }: { install: InstallInfo }) {
  return (
    <>
      Code à usage unique, valable jusqu'au <span className="text-zinc-300">{dateTime(install.expiresAt)}</span>. Il n'est affiché qu'une fois :
      au besoin, génère une nouvelle commande depuis la fiche de l'hôte (l'ancienne cesse alors de fonctionner).
    </>
  );
}

// HAOS: the agent runs in an add-on (« application » in the HA UI); the token carries the hub address, its pinned key and the code.
function HaosInstall({ install }: { install: InstallInfo }) {
  return (
    <div className="space-y-4">
      <ol className="list-inside list-decimal space-y-3 text-zinc-300">
        <li>
          Dans Home Assistant, <strong className="text-zinc-100">Paramètres › Applications › Boutique › ⋮ › Dépôts</strong> (ex-Modules complémentaires), ajoute :
          <div className="mt-2"><CopyField value={HAOS_ADDON_REPO} /></div>
        </li>
        <li>Installe l'application <strong className="text-zinc-100">Homelab Manager Agent</strong>.</li>
        <li>
          Dans son onglet <strong className="text-zinc-100">Configuration</strong>, colle ce jeton dans <code>install_token</code>, puis démarre l'application :
          <div className="mt-2">
            {install.haosToken ? (
              <CopyField value={install.haosToken} multiline />
            ) : (
              <p className="text-red-400">URL du hub invalide : corrige « URL du hub » dans les paramètres.</p>
            )}
          </div>
        </li>
        <li>Active <strong className="text-zinc-100">Mise à jour automatique</strong> : l'agent se met à jour avec les versions de l'application.</li>
      </ol>
      <ul className="list-inside list-disc space-y-1 text-xs text-muted">
        <li><CodeValidity install={install} /></li>
        <li>
          Le jeton contient l'adresse du hub, sa clé épinglée et le code : l'application refuse un autre serveur. Il ne sert qu'au premier démarrage, le
          certificat de l'agent est ensuite gardé dans l'application.
        </li>
        <li>L'application voit le réseau de la VM : sa sauvegarde Proxmox VE (vzdump) se rattache seule à cet hôte.</li>
      </ul>
    </div>
  );
}

function LinuxInstall({ install }: { install: InstallInfo }) {
  const [dir, setDir] = useState('');
  const dirOk = !dir || DIR_RE.test(dir);
  const command = install.installCommand && `${install.installCommand}${dir && dirOk ? ` --dir ${dir.replace(/\/+$/, '')}` : ''}`;
  return (
    <div className="space-y-4">
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
        <li><CodeValidity install={install} /></li>
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
