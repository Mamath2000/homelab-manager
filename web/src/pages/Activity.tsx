import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { History } from 'lucide-react';
import { JobStatusIcon } from '../components/JobConsole';
import { HeaderTitle } from '../components/HeaderSlot';
import { Badge, Empty, ResponsiveList, Spinner, Tag } from '../components/ui';
import { actionLabel, byLabel, jobTitle, dateTime, duration } from '../lib/format';
import type { Job } from '../lib/api';
import { useJobs } from '../lib/queries';

const TRIGGERS: { value: Job['trigger']; label: string }[] = [
  { value: 'manual', label: 'Manuelle' },
  { value: 'schedule', label: 'Planifiée' },
  { value: 'retry', label: 'Rejeu' },
  { value: 'homeassistant', label: 'Home Assistant' },
  { value: 'enroll', label: 'À l’ajout' },
];

// How a job started, and who launched it (manual and Home Assistant jobs)
function Trigger({ j }: { j: Job }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {j.trigger === 'schedule' ? <Badge tone="info">planifiée</Badge> : j.trigger === 'retry' ? <Badge tone="warn">rejeu</Badge> : j.trigger === 'homeassistant' ? <Badge tone="unknown">Home Assistant</Badge> : j.trigger === 'enroll' ? <Badge tone="info">à l'ajout</Badge> : <Badge>manuelle</Badge>}
      {j.by && j.by.kind !== 'homeassistant' && <span className="text-xs text-muted">par {byLabel(j.by)}</span>}
    </span>
  );
}

export function Activity() {
  const { data: jobs, isLoading } = useJobs();
  const navigate = useNavigate();
  const [action, setAction] = useState('');
  const [host, setHost] = useState('');
  const [trigger, setTrigger] = useState('');
  if (isLoading || !jobs) return <div className="flex justify-center p-20"><Spinner /></div>;
  const actions = [...new Set(jobs.map((j) => j.action))].sort((a, b) => (actionLabel[a] ?? a).localeCompare(actionLabel[b] ?? b, 'fr'));
  const hosts = [...new Map(jobs.map((j) => [j.hostId, j.hostName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'fr'));
  const filteredJobs = jobs.filter((j) =>
    (!action || j.action === action) &&
    (!host || j.hostId === host) &&
    (!trigger || j.trigger === trigger),
  );
  return (
    <>
      <HeaderTitle icon={History} title="Activité" />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="min-w-0">
          <span className="mb-1 block text-xs text-muted">Type d’action</span>
          <select className="input w-full" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Tous</option>
            {actions.map((value) => <option key={value} value={value}>{actionLabel[value] ?? value}</option>)}
          </select>
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-xs text-muted">Hôte</span>
          <select className="input w-full" value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="">Tous</option>
            {hosts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-xs text-muted">Type de déclenchement</span>
          <select className="input w-full" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
            <option value="">Tous</option>
            {TRIGGERS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <div className="panel min-w-0">
        {jobs.length === 0 ? (
          <Empty icon={History} title="Aucune tâche">Les recherches et installations de mises à jour apparaîtront ici.</Empty>
        ) : filteredJobs.length === 0 ? (
          <Empty icon={History} title="Aucune tâche">Rien ne correspond à ces filtres.</Empty>
        ) : (
          <>
          <ResponsiveList mode="mobile">
            {filteredJobs.map((j) => (
              <Link key={j.id} to={`/jobs/${j.id}`} className="block space-y-3 p-4 transition hover:bg-raised/50">
                <div className="flex min-w-0 items-start gap-3">
                  <JobStatusIcon status={j.status} />
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-sm text-zinc-100">{jobTitle(j)}</div>
                    {j.packages.length > 0 && <div className="mt-1 break-words text-xs text-muted">{j.packages.length > 3 ? `${j.packages.length} paquets` : j.packages.join(', ')}</div>}
                    {j.error && <div className="mt-1 break-words text-xs text-red-400">{j.error}</div>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Tag>{j.hostName}</Tag>
                  <Trigger j={j} />
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400">
                  <div><span className="text-muted">Date · </span>{dateTime(j.createdAt)}</div>
                  <div><span className="text-muted">Durée · </span>{duration(j.createdAt, j.finishedAt)}</div>
                </div>
              </Link>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
          <table className="w-full text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className="th w-10" />
                <th className="th">Tâche</th>
                <th className="th">Hôte</th>
                <th className="th">Déclenchement</th>
                <th className="th">Date</th>
                <th className="th">Durée</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredJobs.map((j) => (
                <tr key={j.id} onClick={() => navigate(`/jobs/${j.id}`)} className="cursor-pointer hover:bg-raised/50">
                  <td className="td"><JobStatusIcon status={j.status} /></td>
                  <td className="td">
                    <span className="text-zinc-100">{jobTitle(j)}</span>
                    {j.packages.length > 0 && <span className="ml-2 text-xs text-muted">{j.packages.length > 3 ? `${j.packages.length} paquets` : j.packages.join(', ')}</span>}
                    {j.error && <span className="ml-2 text-xs text-red-400">{j.error}</span>}
                  </td>
                  <td className="td"><Tag>{j.hostName}</Tag></td>
                  <td className="td"><Trigger j={j} /></td>
                  <td className="td text-xs text-zinc-400">{dateTime(j.createdAt)}</td>
                  <td className="td text-xs text-zinc-400">{duration(j.createdAt, j.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </ResponsiveList>
          </>
        )}
      </div>
    </>
  );
}
