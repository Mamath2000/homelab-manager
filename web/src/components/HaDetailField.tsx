import type { HaHostLevel } from '../lib/api';
import { HA_HOST_LEVELS } from '../lib/haDetail';

// Level of detail of a host in Home Assistant ('' : follows the global level, set in Paramètres > Home Assistant)
export function HaDetailField({ value, onChange }: { value: HaHostLevel | null; onChange: (v: HaHostLevel | null) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-zinc-200">Niveau de détail dans Home Assistant</span>
      <select className="input" value={value ?? ''} onChange={(e) => onChange((e.target.value || null) as HaHostLevel | null)}>
        {HA_HOST_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
      <span className="mt-1 block text-xs text-muted">
        Entités publiées pour cet hôte. « Aucun » : ni appareil, ni alertes, ni compteurs.
      </span>
    </label>
  );
}
