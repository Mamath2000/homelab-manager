import { useState } from 'react';
import { Check, HelpCircle, Search, X } from 'lucide-react';
import { Modal } from './ui';

// Window of the hosts left out of a destination list (mount, database restore): one column per prerequisite,
// ✓ met, ✗ missing, ? unknown, the note in the tooltip, and the first missing one as the reason.

export interface HostCheckItem {
  ok: boolean | null;
  note: string | null;
}
export interface ExcludedHost {
  id: string;
  name: string;
  reason: string | null;
  checks?: Record<string, HostCheckItem | undefined>;
}
export interface CheckColumn {
  key: string;
  label: string;
  title: string;
}

function CheckMark({ item }: { item?: HostCheckItem }) {
  if (!item || item.ok === null)
    return (
      <span title={item?.note ?? 'inconnu'} className="inline-flex">
        <HelpCircle className="h-4 w-4 text-muted" aria-label="inconnu" />
      </span>
    );
  return item.ok ? (
    <span title={item.note ?? 'OK'} className="inline-flex">
      <Check className="h-4 w-4 text-emerald-400" aria-label="OK" />
    </span>
  ) : (
    <span title={item.note ?? 'manquant'} className="inline-flex">
      <X className="h-4 w-4 text-red-400" aria-label="manquant" />
    </span>
  );
}

export function ExcludedHostsModal({ open, onClose, hosts, columns }: { open: boolean; onClose: () => void; hosts: ExcludedHost[]; columns: CheckColumn[] }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle ? hosts.filter((h) => h.name.toLowerCase().includes(needle) || (h.reason ?? '').toLowerCase().includes(needle)) : hosts;
  const close = () => {
    setQ('');
    onClose();
  };
  return (
    <Modal open={open} onClose={close} wide="screen" fixed title={`Hôtes écartés (${hosts.length})`}>
      <div className="flex h-full flex-col gap-3">
        <label className="relative block shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
          <input className="input pl-8" placeholder="Hôte ou raison…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="text-sm text-muted">Aucun hôte pour cette recherche.</p>
          ) : (
            <table className="w-full table-fixed text-left text-sm">
              <thead className="sticky top-0 z-10 bg-panel text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="w-[34%] py-2 pr-4 font-medium">Hôte</th>
                  {columns.map((col) => (
                    <th key={col.key} className="px-1 py-2 text-center font-medium" title={col.title}>
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((h) => (
                  <tr key={h.id} className="align-top">
                    <td className="py-2 pr-4">
                      <span className="block truncate font-medium text-zinc-200" title={h.name}>
                        {h.name}
                      </span>
                      {h.reason && <span className="block text-[11px] text-red-400/90">{h.reason}</span>}
                    </td>
                    {columns.map((col) => (
                      <td key={col.key} className="px-1 py-2 text-center">
                        <CheckMark item={h.checks?.[col.key]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Modal>
  );
}
