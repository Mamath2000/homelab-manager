import { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { ApiError, setReauthPrompt } from '../lib/api';
import { passkeyErrorMessage, proveSession } from '../lib/passkeys';
import { Button, Modal } from './ui';

// Sensitive actions (homelab#291): the hub answered 403 reauth_required, the passkey of the account is asked again
// before the request is sent once more (lib/api.ts). The requests waiting at the same time share one prompt. The
// browser dialog opens from the click on the button: some browsers refuse it without a gesture of the user.
export function ReauthPrompt() {
  const [pending, setPending] = useState<{ resolve: () => void; reject: (err: Error) => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const waiting = useRef<Promise<void> | null>(null);

  useEffect(() => {
    setReauthPrompt(() => {
      waiting.current ??= new Promise<void>((resolve, reject) => setPending({ resolve, reject })).finally(() => {
        waiting.current = null;
      });
      return waiting.current;
    });
    return () => setReauthPrompt(null);
  }, []);

  const close = () => {
    setPending(null);
    setError('');
  };

  const cancel = () => {
    pending?.reject(new ApiError(403, 'Action annulée : la passkey n’a pas été confirmée.'));
    close();
  };

  const confirm = async () => {
    setError('');
    setBusy(true);
    try {
      await proveSession();
      pending?.resolve();
      close();
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!pending}
      onClose={cancel}
      title="Confirmer avec votre passkey"
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>Annuler</Button>
          <Button variant="primary" icon={KeyRound} loading={busy} onClick={confirm} autoFocus>Utiliser ma passkey</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-zinc-300">
        <p>Cette action est sensible : confirmez-la avec votre passkey (navigateur ou gestionnaire de mots de passe).</p>
        <p className="text-xs text-muted">La confirmation vaut 5 minutes pour les actions suivantes.</p>
        {error && <p className="text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}
