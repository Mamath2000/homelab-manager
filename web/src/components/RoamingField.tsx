import { Checkbox } from './ui';

// Host not connected permanently (laptop...): offline is shown as « Absent », without error nor alert
export function RoamingField({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <span className="mt-0.5"><Checkbox checked={checked} onChange={onChange} /></span>
      <span>
        <span className="block text-sm text-zinc-200">Itinérant</span>
        <span className="block text-xs text-muted">Pas connecté en permanence : hors ligne, il n'est pas signalé en erreur.</span>
      </span>
    </label>
  );
}
