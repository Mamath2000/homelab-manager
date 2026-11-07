import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api, type AccessKey, type AccessKeyInfo, type AccessReport, type Host } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useMe } from '../lib/auth';
import { useHosts, useUpdateHostCache } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, ConfirmModal } from './ui';

const keyLine = (k: AccessKeyInfo) => (
  <li key={k.fingerprint} className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs text-zinc-300">
    <span>{k.fingerprint}</span>
    <span className="text-muted">{k.type}</span>
    {k.comment && <span className="text-muted">{k.comment}</span>}
  </li>
);

// Paramètres > Standardisation > Accès : the signed manifest holding the root keys, the sudo user and its keys. It is
// signed on the admin workstation (make access-manifest), never here: the hub only stores it and relays it.
export function SetupAccess() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'access'], queryFn: api.accessSettings });
  const hosts = useHosts().data ?? [];
  const [busy, setBusy] = useState<'reload' | 'apply' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const access = data?.access ?? null;

  const reload = async () => {
    setBusy('reload');
    try {
      const next = await api.reloadAccess();
      qc.setQueryData(['settings', 'access'], next);
      if (next.sync.state === 'error') toast.error(next.sync.detail ?? 'manifeste refusé');
      else if (next.sync.state === 'none') toast.error('aucun manifeste dans le dossier access du hub');
      else toast.success('Dossier relu');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const managed = hosts.filter((h) => h.capabilities.includes('setup'));
  const apply = async () => {
    setBusy('apply');
    try {
      const r = await api.applyAccess();
      setConfirm(false);
      toast.success(`${r.started} hôte(s) en cours d'application${r.offline.length ? ` ; hors ligne : ${r.offline.join(', ')}` : ''}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h3 className="text-base font-medium text-zinc-100">Accès root et utilisateur</h3>
      <p className="text-xs text-muted">
        Les clés SSH de root, l'utilisateur sudo et ses clés viennent d'un manifeste <strong>signé hors ligne</strong>, avec une clé d'administration que le hub
        ne détient pas. Le hub le conserve et le relaie ; chaque agent vérifie la signature avec sa propre ancre avant de toucher à{' '}
        <code>authorized_keys</code> ou à sudo. Un hub compromis ne peut donc pas ajouter de clé root.
      </p>
      <div className="rounded-md border border-line bg-raised/40 p-3 text-xs text-muted">
        Pour modifier l'accès : éditer <code>tools/access.json</code>, puis lancer <code>make access-publish</code> sur votre poste (signature avec votre clé, puis
        dépôt dans le dossier <code>access/</code> du hub, relu toutes les 30 s). Revenez ici appliquer le manifeste aux hôtes.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button icon={RefreshCw} loading={busy === 'reload'} onClick={() => void reload()}>
          Relire le dossier
        </Button>
        <Button variant="primary" icon={ShieldCheck} disabled={!access} onClick={() => setConfirm(true)}>
          Appliquer aux hôtes
        </Button>
      </div>

      {data?.sync.state === 'error' && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">Dernier manifeste déposé refusé : {data.sync.detail}</p>
      )}

      {!access ? (
        <p className="text-sm text-amber-300">Aucun manifeste chargé : les options « Clés SSH » et « Compte » ne peuvent rien appliquer.</p>
      ) : (
        <div className="space-y-3 rounded-md border border-line p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="ok">n° {access.serial}</Badge>
            <span className="text-xs text-muted">
              émis {timeAgo(access.issuedAt * 1000)}, chargé {timeAgo(new Date(access.uploadedAt).getTime())}
              {access.expiresAt ? `, expire ${new Date(access.expiresAt * 1000).toLocaleDateString()}` : ''}
            </span>
          </div>
          <Section title="Signataires autorisés (nouvelle ancre des hôtes)">
            <ul className="space-y-0.5">{access.signers.map(keyLine)}</ul>
            <p className="mt-1 text-xs text-muted">Signé par {access.signer}</p>
          </Section>
          <Section title={`root : ${access.root.length} clé(s)`}>
            <ul className="space-y-0.5">{access.root.map(keyLine)}</ul>
          </Section>
          <Section title={access.user ? `Utilisateur ${access.user.name}${access.user.sudoNoPassword ? ' (sudo sans mot de passe)' : ''} : ${access.user.keys.length} clé(s)` : 'Utilisateur'}>
            {access.user ? <ul className="space-y-0.5">{access.user.keys.map(keyLine)}</ul> : <p className="text-xs text-muted">Aucun utilisateur dans ce manifeste.</p>}
          </Section>
        </div>
      )}

      <AnchorTable hosts={managed} signers={access?.signers.map((s) => s.fingerprint) ?? []} />

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void apply()}
        loading={busy === 'apply'}
        title="Appliquer le manifeste d'accès"
        confirmLabel={`Appliquer à ${managed.filter((h) => h.online).length} hôte(s)`}
      >
        <div className="space-y-2 text-sm">
          <p>
            Manifeste n° {access?.serial} : clés ajoutées, clés retirées du manifeste précédent (celles posées par Homelab Manager seulement) et utilisateur mis à
            jour sur les hôtes qui gèrent ces options.
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{title}</h4>
      {children}
    </div>
  );
}

// State of the trust anchor of each host: pinned signers, open migration window, manifest in use.
function AnchorTable({ hosts, signers }: { hosts: Host[]; signers: string[] }) {
  if (!hosts.length) return null;
  const state = (r?: AccessReport) => {
    if (!r) return <span className="text-xs text-zinc-500">non vérifié</span>;
    if (r.status === 'error') return <Badge tone="bad">refusé</Badge>;
    if (!r.signers.length) return <Badge tone="warn">sans ancre{r.tofuUntil ? ` · fenêtre jusqu'au ${new Date(r.tofuUntil).toLocaleDateString()}` : ' · fenêtre fermée'}</Badge>;
    return r.signers.some((s) => signers.includes(s)) ? <Badge tone="ok">ancre ok</Badge> : <Badge tone="warn">ancre différente</Badge>;
  };
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Ancre de confiance des hôtes</h4>
      <ul className="divide-y divide-line/60 rounded-md border border-line text-xs">
        {hosts.map((h) => {
          const r = h.setup?.access;
          return (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
              <span className="text-zinc-200">{h.name}</span>
              <span className="flex items-center gap-2">
                {r && <span className="text-muted">appliqué n° {r.applied || '—'}</span>}
                {state(r)}
              </span>
              {r?.status === 'error' && r.detail && <span className="basis-full truncate font-mono text-[11px] text-amber-200/80" title={r.detail}>{r.detail}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// authorized_keys found on a host, by account; a key the manifest does not list is flagged until an admin validates it
// (bound to its fingerprint: it stays validated while the key stays on the host).
export function HostAccessKeys({ host, account }: { host: Host; account: 'root' | 'user' }) {
  const access = host.setup?.access;
  const toast = useToast();
  const me = useMe();
  const updateHost = useUpdateHostCache();
  const [busy, setBusy] = useState<string | null>(null);
  if (!access) return null;
  const keys: AccessKey[] = access.keys.filter((k) => (account === 'root' ? k.account === 'root' : k.account !== 'root'));
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
      {access.status === 'error' && access.detail && <p className="mb-1 text-xs text-amber-200/80">{access.detail}</p>}
      {keys.length === 0 ? (
        <p className="text-xs text-muted">Aucune clé.</p>
      ) : (
        <ul className="space-y-1">
          {keys.map((k) => (
            <li key={k.account + k.fingerprint} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs">
              <span className={k.managed || k.acknowledged ? 'text-zinc-300' : 'text-amber-300'}>{k.fingerprint}</span>
              <span className="text-muted">{k.comment || k.type}</span>
              {k.options && <span className="text-muted">(options)</span>}
              {!k.managed && !k.acknowledged && <span className="text-amber-300">nouvelle clé : hors manifeste</span>}
              {!k.managed && k.acknowledged && <span className="text-muted">hors manifeste, validée</span>}
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
