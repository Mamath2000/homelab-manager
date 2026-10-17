import { useState } from 'react';
import clsx from 'clsx';
import { Activity } from 'lucide-react';
import { useAllAlerts } from '../lib/queries';
import { siteDays, type SiteCell, type Site, type TimelineFilter } from '../lib/sites';
import { Checkbox, Panel, Segmented } from './ui';

const DAYS = 30;

// Same day key as the hub (local time).
function dayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lastDays() {
  const today = new Date();
  return Array.from({ length: DAYS }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - (DAYS - 1 - i)));
}

const cellColor: Record<SiteCell['level'], string> = {
  ok: 'bg-emerald-500/55',
  warn: 'bg-amber-500',
  alert: 'bg-red-500',
  // nothing recorded that day: hatched
  none: 'bg-raised bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgb(255_255_255/0.04)_4px_6px)]',
};
const levelLabel: Record<SiteCell['level'], string> = { ok: 'sans alerte', warn: 'avertissement', alert: 'alerte', none: 'rien de relevé' };

const shortDate = (d: Date) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });

function cellText(c: SiteCell) {
  if (c.level === 'none' || c.level === 'ok') return levelLabel[c.level];
  return [c.alert && `${c.alert} hôte${c.alert > 1 ? 's' : ''} en alerte`, c.warn && `${c.warn} en avertissement`].filter(Boolean).join(', ');
}

// Arrival of the alerts over 30 days, one row per site: worst level of the day over its hosts.
export function SiteTimeline({ sites }: { sites: Site[] }) {
  const { data } = useAllAlerts();
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [showConnection, setShowConnection] = useState(false);
  const [showUps, setShowUps] = useState(false);
  const dates = lastDays();
  const keys = dates.map(dayKey);

  return (
    <Panel
      title="Arrivée des alertes · 30 jours"
      icon={Activity}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Type d'alerte"
            value={filter}
            onChange={setFilter}
            options={[
              { id: 'all', label: 'Toutes' },
              { id: 'agent', label: 'Connexion' },
              { id: 'apt', label: 'Mises à jour' },
              { id: 'docker', label: 'Docker' },
              { id: 'backups', label: 'Sauvegardes' },
              { id: 'ups', label: 'Onduleurs' },
            ]}
          />
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted">
            <Checkbox label="Afficher les lignes de connexion" checked={showConnection} onChange={setShowConnection} />
            Ligne connexion
          </label>
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted">
            <Checkbox label="Afficher les lignes des onduleurs" checked={showUps} onChange={setShowUps} />
            Ligne onduleurs
          </label>
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap gap-x-3.5 gap-y-1 text-[11px] text-muted">
        {(['ok', 'warn', 'alert', 'none'] as const).map((l) => (
          <span key={l} className="inline-flex items-center gap-1.5">
            <i className={clsx('block h-2.5 w-2.5 rounded-[2px]', cellColor[l], l === 'none' && 'ring-1 ring-line')} />
            {levelLabel[l]}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-[3px]">
        {sites.flatMap((site) => {
          const rows: { id: string; label: string; filter: TimelineFilter }[] = [
            { id: 'summary', label: site.name, filter },
            ...(showConnection ? [{ id: 'agent', label: `${site.name} · Connexion`, filter: 'agent' as const }] : []),
            ...(showUps ? [{ id: 'ups', label: `${site.name} · Onduleurs`, filter: 'ups' as const }] : []),
          ];
          return rows.flatMap((row) => {
            const cells = siteDays(site.hosts, data?.days ?? [], keys, row.filter);
            return [
              <span key={`${site.name}-${row.id}-l`} className="max-w-44 truncate text-xs text-muted" title={row.label}>{row.label}</span>,
              <div key={`${site.name}-${row.id}-d`} className="grid grid-cols-[repeat(30,minmax(0,1fr))] gap-[3px]">
                {cells.map((c, i) => (
                  <span
                    key={keys[i]}
                    title={`${row.label} · ${shortDate(dates[i])} : ${cellText(c)}`}
                    aria-label={`${row.label}, ${shortDate(dates[i])} : ${cellText(c)}`}
                    className={clsx('h-5 rounded-[3px]', cellColor[c.level])}
                  />
                ))}
              </div>,
            ];
          });
        })}
        <span />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-muted">
          <span>{shortDate(dates[0])}</span>
          <span>aujourd'hui</span>
        </div>
      </div>
    </Panel>
  );
}
