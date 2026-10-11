import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import { api, type TokenSetupRequest } from '../lib/api';
import { useToast } from '../lib/toast';
import { Button, CopyField } from './ui';

// Command to paste on the PBS / a PVE node: it creates the token and sends it to the hub (single-use
// code, 1 h). The secret is never shown; onDone runs once the hub has it.
export function TokenSetup({ request, where, disabled, onDone }: { request: () => TokenSetupRequest; where: string; disabled?: boolean; onDone: () => void }) {
  const toast = useToast();
  const [setup, setSetup] = useState<{ id: string; command: string; tokenId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: status } = useQuery({
    queryKey: ['token-setup', setup?.id],
    queryFn: () => api.tokenSetupStatus(setup!.id),
    enabled: !!setup,
    refetchInterval: (q) => (q.state.data?.status === 'pending' || !q.state.data ? 2000 : false),
  });
  const done = status?.status === 'done';
  useEffect(() => {
    if (done) {
      toast.success(`Jeton ${status?.tokenId} reçu`);
      onDone();
    }
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    setBusy(true);
    try {
      setSetup(await api.createTokenSetup(request()));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <p>
        Une commande à coller dans un shell root {where} : elle crée l'utilisateur, le jeton et ses droits, puis transmet le jeton au hub. Le secret n'est jamais
        affiché. Commande à usage unique, valable 1 heure.
      </p>
      {!setup || status?.status === 'expired' ? (
        <Button size="sm" icon={KeyRound} loading={busy} disabled={disabled} onClick={generate}>
          {status?.status === 'expired' ? 'Commande expirée : en générer une autre' : 'Générer la commande'}
        </Button>
      ) : (
        <>
          <CopyField value={setup.command} />
          {done ? (
            <p className="flex items-center gap-1.5 text-emerald-400"><CheckCircle2 className="h-4 w-4" />Jeton <code>{status?.tokenId}</code> reçu et enregistré.</p>
          ) : (
            <p className="flex items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin" />En attente du jeton <code>{setup.tokenId}</code>…</p>
          )}
        </>
      )}
    </div>
  );
}
