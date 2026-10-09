import { RotateCw } from 'lucide-react';
import type { AptSummary } from '../lib/api';
import { Badge } from './ui';

// "required" = the host already waits for a reboot; "pending" = pending upgrades will need one.
export function RebootStatus({ summary, compact }: { summary: AptSummary | null; compact?: boolean }) {
  if (summary?.rebootRequired) {
    return (
      <Badge tone="bad" className="gap-1">
        <RotateCw className="h-3 w-3" />
        {compact ? 'reboot' : 'Requis'}
      </Badge>
    );
  }
  if (summary?.rebootPending) {
    return (
      <Badge tone="warn" className="gap-1" >
        <RotateCw className="h-3 w-3" />
        {compact ? 'reboot après MAJ' : `Après MAJ (${summary.rebootPending})`}
      </Badge>
    );
  }
  return compact ? null : <span className="text-muted">—</span>;
}

export function RebootTag() {
  return (
    <Badge tone="warn" className="ml-2 gap-1">
      <RotateCw className="h-3 w-3" />
      reboot
    </Badge>
  );
}
