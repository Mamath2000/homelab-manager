import { useQuery } from '@tanstack/react-query';
import { Cloud, Cpu, Database, DatabaseBackup, ExternalLink, Files, Home, Info, Network, ScrollText, Server, Users } from 'lucide-react';
import { Button, Modal, Panel } from './ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';

export function AboutModal({ open, onClose, dontShowAtStartup, onDontShowAtStartupChange }: {
  open: boolean;
  onClose: () => void;
  dontShowAtStartup: boolean;
  onDontShowAtStartupChange: (value: boolean) => void;
}) {
  const { isSuperAdmin } = useMe();
  const { data: agentSettings } = useQuery({
    queryKey: ['settings', 'agents'],
    queryFn: api.agentSettings,
    enabled: open && !isSuperAdmin,
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="À propos"
      wide="screen-wide"
      scroll
      footer={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              className="h-4 w-4 accent-emerald-500"
              checked={dontShowAtStartup}
              onChange={(event) => onDontShowAtStartupChange(event.target.checked)}
            />
            Ne plus afficher au démarrage
          </label>
          <Button variant="ghost" onClick={onClose}>Fermer</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Panel title="Homelab Manager" icon={Info}>
          <div className="space-y-5 text-sm">
            <p className="max-w-3xl leading-relaxed text-zinc-300">
              Un outil simple, pensé pour les makers qui ont quelques machines à la maison et veulent les garder en bon état sans multiplier les interfaces.
              Depuis un hub léger et des agents sur les hôtes, Homelab Manager rassemble la supervision, les mises à jour APT, le suivi des images Docker et les sauvegardes.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><DatabaseBackup className="h-4 w-4 text-emerald-400" />Proxmox Backup Server</h3>
                <p className="text-xs leading-relaxed text-muted">
                  PBS centralise les sauvegardes et leurs snapshots. Sa déduplication par blocs évite de stocker plusieurs fois les données identiques entre sauvegardes,
                  ce qui réduit l’espace utilisé et les transferts. Homelab Manager s’appuie sur PBS pour suivre les sauvegardes de fichiers et de bases.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Server className="h-4 w-4 text-sky-400" />Proxmox VE</h3>
                <p className="text-xs leading-relaxed text-muted">
                  Suivi des sauvegardes planifiées de machines virtuelles et de conteneurs LXC, avec rattachement automatique à l’hôte correspondant lorsqu’il est identifié.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Database className="h-4 w-4 text-cyan-400" />PostgreSQL</h3>
                <p className="text-xs leading-relaxed text-muted">
                  L’agent sauvegarde les bases choisies, ou le cluster PostgreSQL complet, puis envoie les dumps au PBS. Leur format non compressé permet au PBS de dédupliquer efficacement les données d’une sauvegarde à l’autre.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Files className="h-4 w-4 text-green-400" />MongoDB</h3>
                <p className="text-xs leading-relaxed text-muted">
                  L’agent lance `mongodump` dans le conteneur MongoDB pour les bases choisies, puis envoie les archives au PBS, qui en déduplique les blocs communs entre snapshots.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Home className="h-4 w-4 text-amber-400" />Home Assistant OS</h3>
                <p className="text-xs leading-relaxed text-muted">
                  Publication dans Home Assistant des composants système des hôtes (système, noyau, adresse IP et présence), avec leurs alertes et informations APT/Docker.
                  L’intégration suit aussi les sauvegardes natives de Home Assistant OS, leurs destinations, leur planification et leurs éventuels échecs.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Cloud className="h-4 w-4 text-violet-400" />Plugin Nextcloud AIO</h3>
                <p className="text-xs leading-relaxed text-muted">
                  Un plugin dédié permet de sauvegarder une instance Nextcloud All-in-One, notamment sa base de données, sa configuration et les données de ses utilisateurs.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Users className="h-4 w-4 text-fuchsia-400" />MQTT</h3>
                <p className="text-xs leading-relaxed text-muted">
                  Gestion des utilisateurs du broker MQTT et de leurs accès.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Network className="h-4 w-4 text-blue-400" />Omada</h3>
                <p className="text-xs leading-relaxed text-muted">
                  Récupération des équipements du contrôleur Omada et suivi de leur état.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><ScrollText className="h-4 w-4 text-amber-400" />Logs</h3>
                <p className="text-xs leading-relaxed text-muted">
                  Centralisation des journaux des hôtes dans VictoriaLogs pour les retrouver au même endroit.
                </p>
              </article>
              <article className="rounded-md border border-line bg-raised/30 p-4">
                <h3 className="mb-1 flex items-center gap-2 font-medium text-zinc-100"><Cpu className="h-4 w-4 text-orange-400" />ESPHome</h3>
                <p className="text-xs leading-relaxed text-muted">
                  Suivi de la disponibilité (availability) des appareils ESPHome et centralisation de leurs journaux.
                </p>
              </article>
            </div>
          </div>
        </Panel>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Versions" icon={Info}>
            <dl className="space-y-4 text-sm">
              <div className="rounded-md border border-line bg-raised/30 p-3">
                <dt className="text-xs text-muted">Hub</dt>
                <dd className="mt-1 font-mono text-zinc-100">v{__APP_VERSION__}</dd>
              </div>
              <div className="rounded-md border border-line bg-raised/30 p-3">
                <dt className="text-xs text-muted">Version de l’agent distribuée</dt>
                <dd className="mt-1 font-mono text-zinc-100">
                  {agentSettings?.binaries.find((binary) => binary.version)?.version ?? 'inconnue'}
                </dd>
              </div>
            </dl>
          </Panel>
          <Panel title="Dépôt et créateur" icon={ExternalLink}>
            <div className="flex h-full flex-col justify-center gap-5 sm:flex-row sm:items-center">
              <a
                href="https://github.com/Mamath2000"
                target="_blank"
                rel="noreferrer"
                className="flex shrink-0 flex-col items-center gap-2 text-zinc-300 transition hover:text-emerald-300"
              >
                <img
                  className="h-20 w-20 rounded-full border-2 border-line object-cover shadow-lg shadow-black/20"
                  src="/mamath.jpg"
                  alt="Photo de profil de Mamath"
                  width={80}
                  height={80}
                />
                <span className="text-sm font-medium">Mamath</span>
              </a>
              <div className="flex flex-col items-center gap-3 text-sm sm:items-start">
                <a className="inline-flex items-center gap-2 text-zinc-300 hover:text-emerald-300" href="https://github.com/Mamath2000/homelab-manager" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" /> Dépôt homelab-manager
                </a>
                <a className="text-xs text-muted hover:text-emerald-300" href="https://github.com/Mamath2000" target="_blank" rel="noreferrer">
                  Voir le profil GitHub
                </a>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </Modal>
  );
}
