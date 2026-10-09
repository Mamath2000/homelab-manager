import { useNavigate } from 'react-router';
import { History } from 'lucide-react';
import { JobStatusIcon } from '../components/JobConsole';
import { Badge, Empty, PageHeader, Spinner, Tag } from '../components/ui';
import { actionLabel, dateTime, duration } from '../lib/format';
import { useJobs } from '../lib/queries';

export function Activity() {
  const { data: jobs, isLoading } = useJobs();
  const navigate = useNavigate();
  if (isLoading || !jobs) return <div className="flex justify-center p-20"><Spinner /></div>;
  return (
    <>
      <PageHeader icon={History} title="Activité" />
      <div className="panel overflow-x-auto">
        {jobs.length === 0 ? (
          <Empty icon={History} title="Aucune tâche">Les recherches et installations de mises à jour apparaîtront ici.</Empty>
        ) : (
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
                    <span className="text-zinc-100">{actionLabel[j.action]}</span>
                    {j.packages.length > 0 && <span className="ml-2 text-xs text-muted">{j.packages.length > 3 ? `${j.packages.length} paquets` : j.packages.join(', ')}</span>}
                    {j.error && <span className="ml-2 text-xs text-red-400">{j.error}</span>}
                  </td>
                  <td className="td"><Tag>{j.hostName}</Tag></td>
                  <td className="td">{j.trigger === 'schedule' ? <Badge tone="info">planifiée</Badge> : j.trigger === 'homeassistant' ? <Badge tone="unknown">Home Assistant</Badge> : <Badge>manuelle</Badge>}</td>
                  <td className="td text-xs text-zinc-400">{dateTime(j.createdAt)}</td>
                  <td className="td text-xs text-zinc-400">{duration(j.createdAt, j.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
