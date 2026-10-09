import { useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { Button, Modal } from './ui';

export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    setCurrent('');
    setNext('');
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(current, next);
      toast.success('Mot de passe modifié');
      close();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Changer mon mot de passe">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Mot de passe actuel</span>
          <input className="input" type="password" autoFocus required value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Nouveau mot de passe (8 caractères min.)</span>
          <input className="input" type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>Annuler</Button>
          <Button type="submit" variant="primary" loading={busy}>Enregistrer</Button>
        </div>
      </form>
    </Modal>
  );
}
