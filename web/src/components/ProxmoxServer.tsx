import { useState, type ReactNode } from 'react';
import { Fingerprint, Pencil, Trash2 } from 'lucide-react';
import { timeAgo } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Button, CopyField } from './ui';

// Building blocks shared by the Proxmox Backup Server and Proxmox VE settings, so that both look
// alike: one row per server, and an edit window with the connection on the left and the creation
// of the token on the right.

export interface Connection {
  url: string;
  fingerprint: string;
  tokenId?: string; // PBS: created by its agent, not part of the form
  tokenSecret?: string; // empty: unchanged
  enabled: boolean;
}

export const field = 'mb-1.5 block text-xs font-medium text-muted';

// A followed server: name, address, state of the last poll.
export function ServerRow({ name, tag, url, enabled, polledAt, pollError, details, onEdit, onRemove }: {
  name: string;
  tag?: string;
  url: string;
  enabled: boolean;
  polledAt?: string | null;
  pollError?: string | null;
  details?: string;
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-100">{name}</span>
          {tag && <span className="font-mono text-xs text-muted">{tag}</span>}
          {!enabled ? <Badge tone="neutral">désactivé</Badge> : pollError ? <Badge tone="bad">en erreur</Badge> : polledAt ? <Badge tone="ok">relevé</Badge> : <Badge tone="neutral">jamais relevé</Badge>}
        </div>
        <div className="truncate text-xs text-muted">
          {url || 'adresse non renseignée'}
          {polledAt && <> · relevé {timeAgo(polledAt)}</>}
          {details && <> · {details}</>}
          {pollError && <span className="text-red-400"> · {pollError}</span>}
        </div>
      </div>
      {onEdit && <Button size="sm" variant="ghost" icon={Pencil} title="Modifier" onClick={onEdit} />}
      {onRemove && <Button size="sm" variant="ghost" icon={Trash2} title="Retirer" onClick={onRemove} />}
    </li>
  );
}

// Address, pinned certificate, secret of the token and polling switch of a server (the token id is set
// next to the command that creates it, see TokenSetup). hasSecret null: no secret field (PBS, its agent
// creates the token).
export function ConnectionFields({ form, set, hasSecret, urlPlaceholder, fingerprintHint, fetchFingerprint, enabledLabel }: {
  form: Connection;
  set: (patch: Partial<Connection>) => void;
  hasSecret: boolean | null;
  urlPlaceholder: string;
  fingerprintHint: ReactNode;
  fetchFingerprint: (url: string) => Promise<{ fingerprint: string }>;
  enabledLabel: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const fetchFp = async () => {
    setBusy(true);
    try {
      set({ fingerprint: (await fetchFingerprint(form.url)).fingerprint });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <label className="block">
        <span className={field}>Adresse</span>
        <input className="input" value={form.url} onChange={(e) => set({ url: e.target.value.trim() })} placeholder={urlPlaceholder} spellCheck={false} />
      </label>
      <div>
        <span className={field}>Empreinte du certificat (SHA-256)</span>
        <div className="flex gap-2">
          <input className="input font-mono text-xs" value={form.fingerprint} onChange={(e) => set({ fingerprint: e.target.value.trim() })} placeholder="AB:CD:… (vide : autorités système)" spellCheck={false} />
          <Button icon={Fingerprint} loading={busy} disabled={!form.url} onClick={fetchFp} title="Lit l'empreinte du certificat présenté par le serveur">Récupérer</Button>
        </div>
        <p className="mt-1 text-xs text-muted">{fingerprintHint}</p>
      </div>
      {hasSecret !== null && <label className="block">
        <span className={field}>Secret du jeton {form.tokenId && <span className="font-mono font-normal">({form.tokenId})</span>}</span>
        <input
          className="input font-mono text-xs"
          type="password"
          autoComplete="off"
          value={form.tokenSecret ?? ''}
          onChange={(e) => set({ tokenSecret: e.target.value.trim() })}
          placeholder={hasSecret ? '•••••••• (inchangé)' : 'reçu par la commande, ou à coller'}
        />
      </label>}
      <label className="flex cursor-pointer items-center gap-3">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-emerald-500" />
        <span>{enabledLabel}</span>
      </label>
    </>
  );
}

// Right column of the edit window: what the token is, the command that creates it, the manual way (none
// for a PBS: its agent creates the token).
export function TokenAside({ title, intro, setup, manualScript, manualUi }: { title: string; intro: ReactNode; setup: ReactNode; manualScript?: string; manualUi?: ReactNode }) {
  return (
    <aside className="space-y-2 self-start rounded-md border border-line bg-raised/40 p-4 text-xs text-muted">
      <p className="font-medium text-zinc-100">{title}</p>
      <p>{intro}</p>
      {setup}
      {manualScript && <details>
        <summary className="cursor-pointer">Sans la commande : bloc à coller (affiche le secret à recopier)</summary>
        <div className="mt-2 space-y-2">
          <CopyField multiline value={manualScript} />
          <p>{manualUi}</p>
        </div>
      </details>}
    </aside>
  );
}

export type TestState = { level: 'ok' | 'info' | 'warn' | 'error'; text: string } | null;

export function TestResult({ test }: { test: TestState }) {
  if (!test) return null;
  return <p className={{ ok: 'text-xs text-emerald-400', info: 'text-xs text-muted', warn: 'text-xs text-amber-400', error: 'text-xs text-red-400' }[test.level]}>{test.text}</p>;
}
