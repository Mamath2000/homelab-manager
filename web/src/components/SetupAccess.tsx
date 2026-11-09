import { useState } from 'react';
import { Check, KeyRound, X } from 'lucide-react';
import { api, type AccessKey, type Host } from '../lib/api';
import { useMe } from '../lib/auth';
import { useHosts, useUpdateHostCache } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, ConfirmModal } from './ui';

// Paramètres > Standardisation, sections root and user: pushes the root keys, the sudo user and its keys to every host
// that manages them, after a change of the standard (the others options wait for their next application).
export function ApplyAccess({ dirty }: { dirty: boolean }) {
  const toast = useToast();
  const hosts = useHosts().data ?? [];
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const managed = hosts.filter((h) => h.capabilities.includes('setup'));
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.applyAccess();
      setConfirm(false);
      toast.success(`${r.started} hôte(s) en cours d'application${r.offline.length ? ` ; hors ligne : ${r.offline.join(', ')}` : ''}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-raised/40 p-3 text-xs text-muted">
        <span className="flex-1">Clés SSH et compte : après une modification enregistrée, les pousser tout de suite sur les hôtes qui les gèrent.</span>
        <Button icon={KeyRound} disabled={dirty || !managed.length} title={dirty ? "Enregistrer d'abord la configuration" : undefined} onClick={() => setConfirm(true)}>
          Appliquer les accès aux hôtes
        </Button>
      </div>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void apply()}
        loading={busy}
        title="Appliquer les accès"
        confirmLabel={`Appliquer à ${managed.filter((h) => h.online).length} hôte(s)`}
      >
        <div className="space-y-2 text-sm">
          <p>
            Clés SSH de root, utilisateur et ses clés : ajoutées, ou retirées quand Homelab Manager les avait posées, sur les hôtes qui gèrent ces options. Les
            autres clés ne sont jamais touchées.
          </p>
          <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-muted">
            {managed.map((h) => (
              <li key={h.id}>
                {h.name}
                {h.online ? '' : ' (hors ligne : ignoré)'}
              </li>
            ))}
          </ul>
        </div>
      </ConfirmModal>
    </>
  );
}

// authorized_keys found on a host, by account; a key the configuration does not list is flagged until an admin validates it
// (bound to its fingerprint: it stays validated while the key stays on the host).
export function HostAccessKeys({ host, account }: { host: Host; account: 'root' | 'user' }) {
  const access = host.setup?.access;
  const toast = useToast();
  const me = useMe();
  const updateHost = useUpdateHostCache();
  const [busy, setBusy] = useState<string | null>(null);
  if (!access) return null;
  // one entry per account + fingerprint (it is the row key; older agents report a repeated line twice)
  const keys: AccessKey[] = access.keys
    .filter((k) => (account === 'root' ? k.account === 'root' : k.account !== 'root'))
    .filter((k, i, all) => all.findIndex((o) => o.account === k.account && o.fingerprint === k.fingerprint) === i);
  const fresh = keys.filter((k) => !k.managed && !k.acknowledged);
  const canAck = me?.profile === 'admin';
  const ack = async (k: AccessKey, acknowledged: boolean) => {
    setBusy(k.account + k.fingerprint);
    try {
      updateHost(await api.ackAccessKey(host.id, k.account, k.fingerprint, acknowledged));
    } catch (err) {
      toast.error((err as Error).message);
    }
    setBusy(null);
  };
  return (
    <div className="mt-3 rounded-md border border-line/60 p-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-300">
        Clés présentes sur l'hôte ({keys.length})
        {fresh.length > 0 && <Badge tone="warn">{fresh.length} nouvelle(s)</Badge>}
      </div>
      {access.status === 'error' && access.detail && <p className="mb-1 text-xs text-amber-200/80">{access.detail} (agent à mettre à jour)</p>}
      {keys.length === 0 ? (
        <p className="text-xs text-muted">Aucune clé.</p>
      ) : (
        <ul className="space-y-1">
          {keys.map((k) => (
            <li key={k.account + k.fingerprint} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs">
              <span className={k.managed || k.acknowledged ? 'text-zinc-300' : 'text-amber-300'}>{k.fingerprint}</span>
              <span className="text-muted">{k.comment || k.type}</span>
              {k.options && <span className="text-muted">(options)</span>}
              {!k.managed && !k.acknowledged && <span className="text-amber-300">nouvelle clé : hors configuration</span>}
              {!k.managed && k.acknowledged && <span className="text-muted">hors configuration, validée</span>}
              {!k.managed && canAck && (
                <button
                  type="button"
                  className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-zinc-400 hover:bg-white/5 hover:text-zinc-100 disabled:opacity-50"
                  title={k.acknowledged ? 'Annuler la validation : la clé sera de nouveau signalée' : 'Valider cette clé : elle ne déclenche plus le badge'}
                  disabled={busy === k.account + k.fingerprint}
                  onClick={() => ack(k, !k.acknowledged)}
                >
                  {k.acknowledged ? <><X className="h-3.5 w-3.5" aria-hidden="true" />Annuler</> : <><Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />Valider</>}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
