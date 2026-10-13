import { Checkbox } from './ui';

// Host left out of the Home Assistant discovery: no device, not counted in the totals
export function HaExcludedField({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <span className="mt-0.5"><Checkbox checked={checked} onChange={onChange} /></span>
      <span>
        <span className="block text-sm text-zinc-200">Exclu de Home Assistant</span>
        <span className="block text-xs text-muted">Pas publié dans la découverte MQTT : ni appareil, ni alertes, ni compteurs.</span>
      </span>
    </label>
  );
}
