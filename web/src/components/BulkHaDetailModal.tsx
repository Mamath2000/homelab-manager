import { useState } from 'react';
import { api, type Host, type HaHostLevel } from '../lib/api';
import { useUpdateHostCache } from '../lib/queries';
import { useToast } from '../lib/toast';
import { HaDetailField } from './HaDetailField';
import { ConfirmModal, Tag } from './ui';

// Same level of detail in Home Assistant for several hosts (group action: the modal lists the targets)
export function BulkHaDetailModal({ hosts, open, onClose }: { hosts: Host[]; open: boolean; onClose: () => void }) {
  const [level, setLevel] = useState<HaHostLevel | null>(null);
  const [busy, setBusy] = useState(false);
  const upsert = useUpdateHostCache();
  const toast = useToast();

  const apply = async () => {
    setBusy(true);
    try {
      for (const h of await api.setHostsHaDetail(hosts.map((x) => x.id), level)) upsert(h);
      toast.success(`Niveau Home Assistant appliqué à ${hosts.length} hôte(s)`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmModal open={open} onClose={onClose} title="Niveau de détail dans Home Assistant" confirmLabel="Appliquer" loading={busy} onConfirm={() => void apply()}>
      <div className="mb-4"><HaDetailField value={level} onChange={setLevel} /></div>
      <p className="mb-2 text-sm">S'applique à :</p>
      <div className="flex flex-wrap gap-1.5">{hosts.map((h) => <Tag key={h.id}>{h.name}</Tag>)}</div>
    </ConfirmModal>
  );
}
