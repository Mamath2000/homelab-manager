import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { RefreshCw, Wand2 } from 'lucide-react';
import { api, SETUP_MODULES, type Host, type SetupModule, type SetupState } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { setupModuleInfo, showSetup } from '../lib/setup';
import { useUpdateHostCache } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, Modal, Spinner } from './ui';

function StateBadge({ check, standard }: { check?: SetupState['modules'][number]; standard: boolean }) {
  if (!standard) return <span className="text-xs text-zinc-600">hors standard</span>;
  if (!check) return <span className="text-xs text-zinc-500">non vérifié</span>;
  switch (check.state) {
    case 'ok':
      return <Badge tone="ok">conforme</Badge>;
    case 'drift':
      return <Badge tone="warn">écart</Badge>;
    case 'na':
      return <Badge tone="unknown">sans objet</Badge>;
    default:
      return <Badge tone="bad">erreur</Badge>;
  }
}

function driftLabel(n: number) {
  return `${n} écart${n > 1 ? 's' : ''}`;
}

// Header button of the host page, with the number of options that differ from the standard.
export function SetupButton({ host, onOpen }: { host: Host; onOpen: () => void }) {
  if (!showSetup(host)) return null;
  const drift = host.setup?.drift ?? 0;
  return (
    <Button icon={Wand2} variant="ghost" onClick={onOpen} title={`Standardisation${drift ? ` : ${driftLabel(drift)}` : ''}`}>
      {drift > 0 && <Badge tone="warn">{drift}</Badge>}
    </Button>
  );
}

// Conformity in one line (panel Système), opening the same window.
export function SetupStatus({ host, onOpen }: { host: Host; onOpen: () => void }) {
  if (!host.capabilities.includes('setup')) return <>—</>;
  const drift = host.setup?.drift ?? 0;
  return (
    <button onClick={onOpen} className="hover:underline">
      {!host.setup ? <span className="text-muted">non vérifié</span> : drift ? <span className="text-amber-300">{driftLabel(drift)}</span> : <span className="text-emerald-400">conforme</span>}
    </button>
  );
}

// Standardisation of one host: the options to push (pre-checked with the standard configuration),
// the conformity of each one, and a confirmation step before applying.
export function SetupModal({ host, open, onClose, running, onStarted }: { host: Host; open: boolean; onClose: () => void; running: boolean; onStarted: (jobId: string) => void }) {
  const { canWrite, canManage } = useMe();
  const toast = useToast();
  const updateHost = useUpdateHostCache();
  const { data: standard } = useQuery({ queryKey: ['setup'], queryFn: api.setupStandard, enabled: open });
  // pre-checked with the standard configuration, user of the host or of the profile, until edited
  const [selectedDraft, setSelected] = useState<Set<SetupModule> | null>(null);
  const [userDraft, setUser] = useState<string | null>(null);
  const [busy, setBusy] = useState<'apply' | 'check' | null>(null);

  const close = () => {
    setSelected(null);
    setUser(null);
    onClose();
  };
  const available = host.capabilities.includes('setup');
  if (!open) return null;
  if (!available || !standard) {
    return (
      <Modal open onClose={close} title="Standardisation">
        {available ? <div className="flex justify-center p-6"><Spinner /></div> : <p className="text-sm text-muted">Disponible après la mise à jour de l'agent de cet hôte.</p>}
      </Modal>
    );
  }

  const selected = selectedDraft ?? new Set(standard.modules);
  const user = userDraft ?? host.setupUser ?? standard.user;
  const checks = new Map(host.setup?.modules.map((m) => [m.module, m]));
  const chosen = SETUP_MODULES.filter((m) => selected.has(m));
  const toggle = (m: SetupModule) => {
    const next = new Set(selected);
    if (next.has(m)) next.delete(m);
    else next.add(m);
    setSelected(next);
  };
  const userOk = user === '' || /^[a-z_][a-z0-9_-]{0,31}$/.test(user);

  const apply = async () => {
    setBusy('apply');
    try {
      const job = await api.applySetup(host.id, chosen, user);
      if (job.status === 'failed') toast.error(job.error ?? 'échec');
      else {
        onStarted(job.id);
        close();
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    setBusy('check');
    try {
      updateHost(await api.checkSetup(host.id));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const drift = host.setup?.drift ?? 0;
  // a unit action: launched at once, the job console shows the result (see CLAUDE.md)
  const footer = !canWrite ? (
    <Button onClick={close}>Fermer</Button>
  ) : (
    <>
      <Button onClick={close}>Annuler</Button>
      <Button variant="primary" icon={Wand2} loading={busy === 'apply'} disabled={!host.online || running || chosen.length === 0 || !userOk} onClick={apply}>
        Appliquer la sélection
      </Button>
    </>
  );

  return (
    <Modal
      open
      onClose={close}
      wide
      title={
        <span className="flex items-center gap-2">
          Standardisation de {host.name}
          {host.setup && (drift ? <Badge tone="warn">{driftLabel(drift)}</Badge> : <Badge tone="ok">conforme</Badge>)}
        </span>
      }
      footer={footer}
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Utilisateur</span>
            <input
              className={`input h-8 max-w-[12rem] py-1 ${userOk ? '' : 'border-red-500/60'}`}
              value={user}
              onChange={(e) => setUser(e.target.value.trim())}
              placeholder="root seulement"
              disabled={!canWrite}
              spellCheck={false}
            />
            {user !== standard.user && <span className="text-xs text-zinc-500">standard : {standard.user || 'root seulement'}</span>}
          </label>
          {canWrite && (
            <Button size="sm" icon={RefreshCw} variant="ghost" loading={busy === 'check'} disabled={!host.online} onClick={check}>
              Vérifier
            </Button>
          )}
        </div>
        <ul className="divide-y divide-line/60">
          {SETUP_MODULES.map((m) => {
            const c = checks.get(m);
            return (
              <li key={m} className="flex items-start gap-3 py-2">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-500" checked={selected.has(m)} onChange={() => toggle(m)} disabled={!canWrite} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-200">{setupModuleInfo[m].label}</span>
                    <StateBadge check={c} standard={standard.modules.includes(m)} />
                  </div>
                  {c?.detail && c.state !== 'ok' ? (
                    <p className="mt-0.5 truncate font-mono text-[11px] text-amber-200/80" title={c.detail}>{c.detail}</p>
                  ) : (
                    <p className="mt-0.5 text-xs text-zinc-500">{setupModuleInfo[m].hint}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted">
          {host.setup ? <>Vérifié {timeAgo(host.setup.checkedAt)}. </> : null}
          Valeurs de la {canManage ? <Link to="/settings?tab=setup" className="text-emerald-400 hover:underline">configuration standard</Link> : 'configuration standard'}.
        </p>
      </div>
    </Modal>
  );
}
