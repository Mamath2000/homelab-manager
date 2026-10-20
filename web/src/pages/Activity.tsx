import { Link, useNavigate } from 'react-router';
import { History } from 'lucide-react';
import { JobStatusIcon } from '../components/JobConsole';
import { HeaderTitle } from '../components/HeaderSlot';
import { Badge, Empty, ResponsiveList, Spinner, Tag } from '../components/ui';
import { jobTitle, dateTime, duration } from '../lib/format';
import { useJobs } from '../lib/queries';

export function Activity() {
  const { data: jobs, isLoading } = useJobs();
  const navigate = useNavigate();
  if (isLoading || !jobs) return <div className="flex justify-center p-20"><Spinner /></div>;
  return (
    <>
      <HeaderTitle icon={History} title="Activité" />
      <div className="panel min-w-0">
        {jobs.length === 0 ? (
          <Empty icon={History} title="Aucune tâche">Les recherches et installations de mises à jour apparaîtront ici.</Empty>
        ) : (
          <>
          <ResponsiveList mode="mobile">
            {jobs.map((j) => (
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
                  {j.trigger === 'schedule' ? <Badge tone="info">planifiée</Badge> : j.trigger === 'homeassistant' ? <Badge tone="unknown">Home Assistant</Badge> : j.trigger === 'enroll' ? <Badge tone="info">à l'ajout</Badge> : <Badge>manuelle</Badge>}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400">
                  <div><span className="text-muted">Date · </span>{dateTime(j.createdAt)}</div>
                  <div><span className="text-muted">Durée · </span>{duration(j.createdAt, j.finishedAt)}</div>
                </div>
              </Link>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
          <table className="w-full min-w-[760px] text-sm">
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
              {jobs.map((j) => (
                <tr key={j.id} onClick={() => navigate(`/jobs/${j.id}`)} className="cursor-pointer hover:bg-raised/50">
                  <td className="td"><JobStatusIcon status={j.status} /></td>
                  <td className="td">
                    <span className="text-zinc-100">{jobTitle(j)}</span>
                    {j.packages.length > 0 && <span className="ml-2 text-xs text-muted">{j.packages.length > 3 ? `${j.packages.length} paquets` : j.packages.join(', ')}</span>}
                    {j.error && <span className="ml-2 text-xs text-red-400">{j.error}</span>}
                  </td>
                  <td className="td"><Tag>{j.hostName}</Tag></td>
                  <td className="td">{j.trigger === 'schedule' ? <Badge tone="info">planifiée</Badge> : j.trigger === 'homeassistant' ? <Badge tone="unknown">Home Assistant</Badge> : j.trigger === 'enroll' ? <Badge tone="info">à l'ajout</Badge> : <Badge>manuelle</Badge>}</td>
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
