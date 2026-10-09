import { useState } from 'react';
import { CircleArrowUp } from 'lucide-react';
import type { Host } from '../lib/api';
import { useRunBulk } from '../lib/queries';
import { Badge, Button, ConfirmModal, CopyField, Tag } from './ui';

export const canSelfUpdate = (h: Host) => h.capabilities.includes('agent_update');

export function AgentBadge({ short }: { short?: boolean }) {
  return (
    <Badge tone="warn" className="gap-1">
      <CircleArrowUp className="h-3 w-3" />
      {short ? 'agent' : 'Agent à mettre à jour'}
    </Badge>
  );
}

// Confirms and starts agent_update on the given hosts; agents too old to update themselves
// are listed with the one-time manual command.
export function UpdateAgentsModal({ hosts, open, onClose }: { hosts: Host[]; open: boolean; onClose: () => void }) {
  const bulk = useRunBulk();
  const auto = hosts.filter(canSelfUpdate);
  const manual = hosts.filter((h) => !canSelfUpdate(h));
  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      title="Mettre à jour les agents"
      confirmLabel={`Mettre à jour ${auto.length} agent(s)`}
      loading={bulk.isPending}
      onConfirm={() => {
        if (!auto.length) return onClose();
        bulk.mutate({ hostIds: auto.map((h) => h.id), action: 'agent_update' }, { onSuccess: onClose });
      }}
    >
      {auto.length > 0 && (
        <>
          <p className="mb-2">L'agent télécharge la nouvelle version depuis le hub, vérifie son empreinte puis redémarre (quelques secondes) :</p>
          <div className="flex flex-wrap gap-1.5">{auto.map((h) => <Tag key={h.id}>{h.name}</Tag>)}</div>
        </>
      )}
      {manual.length > 0 && (
        <div className={auto.length ? 'mt-4' : ''}>
          <p className="mb-2 text-amber-300">
            Trop ancien(s) pour se mettre à jour seul(s) : {manual.map((h) => h.name).join(', ')}. À faire une fois, en root sur l'hôte :
          </p>
          <CopyField value={`curl -fsSL ${window.location.origin}/install.sh | sh`} />
        </div>
      )}
    </ConfirmModal>
  );
}

export function UpdateAgentButton({ hosts, label }: { hosts: Host[]; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" icon={CircleArrowUp} onClick={(e) => { e.preventDefault(); setOpen(true); }}>
        {label ?? "Mettre à jour l'agent"}
      </Button>
      <UpdateAgentsModal hosts={hosts} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
