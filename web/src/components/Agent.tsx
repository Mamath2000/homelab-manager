import { useState } from 'react';
import { CircleArrowUp, ShieldAlert } from 'lucide-react';
import type { Host } from '../lib/api';
import { useRunBulk } from '../lib/queries';
import { canSelfUpdate } from '../lib/status';
import { Badge, Button, ConfirmModal, Tag } from './ui';
import { useMe } from '../lib/auth';

export function AgentBadge({ short }: { short?: boolean }) {
  return (
    <Badge tone="warn" className="gap-1">
      <CircleArrowUp className="h-3 w-3" />
      {short ? 'agent' : 'Agent à mettre à jour'}
    </Badge>
  );
}

// Agent still on the plain-text token: the hub refuses it until it is reinstalled.
export function ReinstallBadge({ short }: { short?: boolean }) {
  return (
    <Badge tone="bad" className="gap-1">
      <ShieldAlert className="h-3 w-3" />
      {short ? 'réinstaller' : 'Réinstallation requise'}
    </Badge>
  );
}

// Confirms and starts agent_update on the given hosts.
export function UpdateAgentsModal({ hosts, open, onClose }: { hosts: Host[]; open: boolean; onClose: () => void }) {
  const bulk = useRunBulk();
  const auto = hosts.filter(canSelfUpdate);
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
      <p className="mb-2">L'agent télécharge la nouvelle version depuis le hub, vérifie son empreinte et sa signature puis redémarre (quelques secondes) :</p>
      <div className="flex flex-wrap gap-1.5">{auto.map((h) => <Tag key={h.id}>{h.name}</Tag>)}</div>
    </ConfirmModal>
  );
}

// Single host: starts right away; several hosts: confirms with the list first.
export function UpdateAgentButton({ hosts, label }: { hosts: Host[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const bulk = useRunBulk();
  if (!useMe().canWrite) return null;
  const auto = hosts.filter(canSelfUpdate);
  return (
    <>
      <Button
        size="sm"
        icon={CircleArrowUp}
        loading={bulk.isPending}
        onClick={(e) => {
          e.preventDefault();
          if (auto.length === 1) bulk.mutate({ hostIds: [auto[0].id], action: 'agent_update' });
          else setOpen(true);
        }}
      >
        {label ?? "Mettre à jour l'agent"}
      </Button>
      <UpdateAgentsModal hosts={hosts} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
