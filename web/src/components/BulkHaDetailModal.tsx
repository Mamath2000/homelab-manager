import { useState } from 'react';
import { api, type Host, type HaHostDetail } from '../lib/api';
import { useUpdateHostCache } from '../lib/queries';
import { useToast } from '../lib/toast';
import { HostHaDetail } from './HostHaDetail';
import { Button, Modal, Tag } from './ui';

// Same level of detail in Home Assistant for several hosts (group action: the window lists the targets)
export function BulkHaDetailModal({ hosts, open, onClose }: { hosts: Host[]; open: boolean; onClose: () => void }) {
  const [level, setLevel] = useState<HaHostDetail | null>(null);
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
    <Modal
      open={open}
      onClose={onClose}
      wide="xl"
      title="Niveau de détail dans Home Assistant"
      footer={
        <>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Annuler</Button>
          <Button type="button" variant="primary" loading={busy} onClick={() => void apply()}>Appliquer</Button>
        </>
      }
    >
      <div className="space-y-5">
        {open && <HostHaDetail hosts={hosts} value={level} onChange={setLevel} />}
        <div className="border-t border-line pt-4">
          <p className="mb-2 text-sm">S'applique à :</p>
          <div className="flex flex-wrap gap-1.5">{hosts.map((h) => <Tag key={h.id}>{h.name}</Tag>)}</div>
        </div>
      </div>
    </Modal>
  );
}
