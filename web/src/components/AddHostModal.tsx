import { useState } from 'react';
import { api, type InstallInfo } from '../lib/api';
import { useUpdateHostCache } from '../lib/queries';
import { InstallInstructions } from './InstallInstructions';
import { Button, Modal } from './ui';

export function AddHostModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InstallInfo | null>(null);
  const upsert = useUpdateHostCache();

  const close = () => {
    setName('');
    setGroup('');
    setError('');
    setResult(null);
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.createHost(name, group);
      upsert(r.host);
      setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title={result ? `Installer l'agent sur ${name}` : 'Ajouter un hôte'} wide={!!result}>
      {result ? (
        <div className="space-y-4">
          <InstallInstructions install={result} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>Terminé</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Nom</span>
            <input className="input" autoFocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="pihole, docker-01, pve…" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Groupe (optionnel)</span>
            <input className="input" maxLength={64} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="infra, media, domotique…" />
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>Annuler</Button>
            <Button type="submit" variant="primary" loading={busy}>Créer</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
