import { useState } from 'react';
import clsx from 'clsx';
import { Activity } from 'lucide-react';
import { hostsDomains, siteDays, type SiteCell } from '../lib/monitoring';
import { useAllAlerts, useStatus } from '../lib/queries';
import type { Site } from '../lib/sites';
import { Panel, Segmented } from './ui';

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
  return [c.alert && `${c.alert} élément${c.alert > 1 ? 's' : ''} en alerte`, c.warn && `${c.warn} en avertissement`].filter(Boolean).join(', ');
}

// Arrival of the alerts over 30 days, one row per site: worst level of the day over its hosts, equipments and
// domains (today: the live status). The filter lists the domains met in the hosts.
export function SiteTimeline({ sites }: { sites: Site[] }) {
  const { data } = useAllAlerts();
  const { data: status } = useStatus();
  const [filter, setFilter] = useState('all');
  const dates = lastDays();
  const keys = dates.map(dayKey);

  return (
    <Panel
      title="Arrivée des alertes · 30 jours"
      icon={Activity}
      actions={
        <Segmented
          label="Type d'alerte"
          value={filter}
          onChange={setFilter}
          options={[{ id: 'all', label: 'Toutes' }, ...hostsDomains(status, sites.flatMap((site) => site.hosts), sites.flatMap((site) => site.equipments)).map((d) => ({ id: d.id, label: d.label }))]}
        />
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
        {sites.map((site) => {
          const cells = siteDays(site.hosts, site.equipments, data?.days ?? [], data?.equipmentDays ?? [], keys, filter, status);
          return [
            <span key={`${site.name}-l`} className="max-w-36 truncate text-xs text-muted" title={site.name}>{site.name}</span>,
            <div key={`${site.name}-d`} className="grid grid-cols-[repeat(30,minmax(0,1fr))] gap-[3px]">
              {cells.map((c, i) => (
                <span
                  key={keys[i]}
                  title={`${site.name} · ${shortDate(dates[i])} : ${cellText(c)}`}
                  aria-label={`${site.name}, ${shortDate(dates[i])} : ${cellText(c)}`}
                  className={clsx('h-5 rounded-[3px]', cellColor[c.level])}
                />
              ))}
            </div>,
          ];
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
