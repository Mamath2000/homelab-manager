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
    <div className="sticky bottom-0 z-20 -mx-4 mt-6 flex flex-wrap items-center gap-3 border-t border-line bg-panel px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_20px_rgba(0,0,0,0.25)] md:static md:mx-0 md:mt-6 md:bg-transparent md:px-0 md:pb-0 md:pt-4 md:shadow-none">
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
