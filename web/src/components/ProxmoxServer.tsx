import { Pencil, Trash2, type LucideIcon } from 'lucide-react';
import { timeAgo } from '../lib/format';
import { Badge, Button } from './ui';

// Building blocks shared by the Proxmox Backup Server and Proxmox VE settings, so that both look
// alike: one row per server (the edit windows: PbsDialog.tsx).

export const field = 'mb-1.5 block text-xs font-medium text-muted';

// A followed server: name, address, state of the last poll (connected: its token is there, it is polled).
export function ServerRow({ name, tag, url, connected, polledAt, pollError, details, onEdit, onRemove, removeTitle = 'Retirer', removeIcon = Trash2 }: {
  name: string;
  tag?: string;
  url: string;
  connected: boolean;
  polledAt?: string | null;
  pollError?: string | null;
  details?: string;
  onEdit?: () => void;
  onRemove?: () => void;
  removeTitle?: string;
  removeIcon?: LucideIcon;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-100">{name}</span>
          {tag && <span className="font-mono text-xs text-muted">{tag}</span>}
          {!connected ? <Badge tone="neutral">non connecté</Badge> : pollError ? <Badge tone="bad">en erreur</Badge> : polledAt ? <Badge tone="ok">relevé</Badge> : <Badge tone="neutral">jamais relevé</Badge>}
        </div>
        <div className="truncate text-xs text-muted">
          {url || 'adresse non renseignée'}
          {polledAt && <> · relevé {timeAgo(polledAt)}</>}
          {details && <> · {details}</>}
          {pollError && <span className="text-red-400"> · {pollError}</span>}
        </div>
      </div>
      {onEdit && <Button size="sm" variant="ghost" icon={Pencil} title="Modifier" onClick={onEdit} />}
      {onRemove && <Button size="sm" variant="ghost" icon={removeIcon} title={removeTitle} onClick={onRemove} />}
    </li>
  );
}
