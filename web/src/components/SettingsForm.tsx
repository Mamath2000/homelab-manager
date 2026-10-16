import type { ReactNode } from 'react';
import { Save, X } from 'lucide-react';
import { Button } from './ui';

export function SettingsFormActions({
  dirty,
  saving,
  onSave,
  onCancel,
  actions,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  actions?: ReactNode;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">
      <p className="text-xs text-muted" aria-live="polite">
        {saving ? 'Enregistrement…' : dirty ? 'Modifications non enregistrées' : 'Tous les changements sont enregistrés'}
      </p>
      <div className="ml-auto flex gap-2">
        {actions}
        <Button type="button" icon={X} disabled={!dirty || saving} onClick={onCancel}>Annuler</Button>
        <Button type="button" variant="primary" icon={Save} disabled={!dirty || saving} loading={saving} onClick={onSave}>Enregistrer</Button>
      </div>
    </div>
  );
}
