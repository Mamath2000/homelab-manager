import { useState } from 'react';
import { Layers } from 'lucide-react';
import type { BackupGroup, BackupSnapshot } from '../lib/api';
import { formatBytes, groupLabel } from '../lib/backups';
import { dateTime, timeAgo } from '../lib/format';
import { Badge, Button, Modal } from './ui';

// Snapshots shown before "voir tout"
const FIRST = 4;

function VerifyBadge({ s, ha }: { s: BackupSnapshot; ha: boolean }) {
  // Home Assistant does not verify its backups
  if (ha) return <span className="text-muted">—</span>;
  if (s.verify === 'ok') return <Badge tone="ok">vérifiée</Badge>;
  if (s.verify === 'failed') return <Badge tone="bad">en échec</Badge>;
  return <Badge tone="warn">non vérifiée</Badge>;
}

// Snapshots of a group (history kept by the hub at the last poll or report), newest first.
export function SnapshotsModal({ group, open, onClose }: { group: BackupGroup; open: boolean; onClose: () => void }) {
  const [all, setAll] = useState(false);
  const ha = group.source === 'haos';
  const list = [...(group.times ?? [])].reverse();
  const shown = all ? list : list.slice(0, FIRST);
  const close = () => {
    setAll(false);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title={`Snapshots · ${groupLabel(group)}`} wide scroll>
      <p className="mb-3 text-xs text-muted">
        {group.store}{group.ns ? ` › ${group.ns}` : ''} · {group.count} snapshot{group.count > 1 ? 's' : ''}
        {list.length < group.count && ` (les ${list.length} derniers connus du hub)`}
      </p>
      {list.length === 0 ? (
        <p className="text-sm text-muted">Aucun snapshot.</p>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className="th">Date</th>
              <th className="th">Taille</th>
              <th className="th">Vérification</th>
              <th className="th">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((s) => (
              <tr key={s.t}>
                <td className="td whitespace-nowrap" title={timeAgo(s.t)}>{dateTime(s.t)}</td>
                <td className="td whitespace-nowrap">{formatBytes(s.size)}</td>
                <td className="td"><VerifyBadge s={s} ha={ha} /></td>
                <td className="td">
                  <span className="text-zinc-300">{s.note || '—'}</span>
                  {s.automatic !== undefined && (
                    <Badge tone="neutral" className="ml-2">{s.automatic ? 'auto' : 'manuelle'}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {list.length > FIRST && (
        <button type="button" className="mt-3 text-xs text-emerald-400 hover:underline" onClick={() => setAll(!all)}>
          {all ? `Seulement les ${FIRST} derniers` : `Voir tout (${list.length})`}
        </button>
      )}
    </Modal>
  );
}

// Small button of a backup row opening its snapshots.
export function SnapshotsButton({ group, className }: { group: BackupGroup; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" icon={Layers} className={className} title="Snapshots de cette sauvegarde" onClick={() => setOpen(true)} />
      <SnapshotsModal group={group} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
