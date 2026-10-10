import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { RefreshCw, Wand2 } from 'lucide-react';
import { api, SETUP_MODULES, type Host, type SetupModule, type SetupState } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { setupModuleInfo } from '../lib/setup';
import { useUpdateHostCache } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, ConfirmModal, Panel } from './ui';

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

// Standardisation of one host: the options to push (pre-checked with the standard configuration)
// and the conformity of each one.
export function SetupPanel({ host, running, onStarted }: { host: Host; running: boolean; onStarted: (jobId: string) => void }) {
  const { canWrite, canManage } = useMe();
  const toast = useToast();
  const updateHost = useUpdateHostCache();
  const { data: standard } = useQuery({ queryKey: ['setup'], queryFn: api.setupStandard });
  // pre-checked with the standard configuration, user of the host or of the profile, until edited
  const [selectedDraft, setSelected] = useState<Set<SetupModule> | null>(null);
  const [userDraft, setUser] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'apply' | 'check' | null>(null);

  if (!host.capabilities.includes('setup')) {
    if (!host.apt) return null;
    return (
      <Panel title="Standardisation" icon={Wand2}>
        <p className="text-sm text-muted">Disponible après la mise à jour de l'agent de cet hôte.</p>
      </Panel>
    );
  }
  if (!standard) return null;
  const selected = selectedDraft ?? new Set(standard.modules);
  const user = userDraft ?? host.setupUser ?? standard.user;

  const checks = new Map(host.setup?.modules.map((m) => [m.module, m]));
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
      const job = await api.applySetup(host.id, SETUP_MODULES.filter((m) => selected.has(m)), user);
      if (job.status === 'failed') toast.error(job.error ?? 'échec');
      else onStarted(job.id);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
      setConfirm(false);
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
  return (
    <Panel
      title={
        <>
          Standardisation
          {host.setup && (drift ? <Badge tone="warn" className="ml-2">{drift} écart{drift > 1 ? 's' : ''}</Badge> : <Badge tone="ok" className="ml-2">conforme</Badge>)}
        </>
      }
      icon={Wand2}
      actions={
        canWrite && <Button size="sm" icon={RefreshCw} variant="ghost" title="Vérifier la conformité" loading={busy === 'check'} disabled={!host.online} onClick={check} />
      }
    >
      <div className="space-y-3 text-sm">
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
                  {c?.detail && c.state !== 'ok' && <p className="mt-0.5 truncate font-mono text-[11px] text-amber-200/80" title={c.detail}>{c.detail}</p>}
                </div>
              </li>
            );
          })}
        </ul>
        {canWrite && (
          <Button className="w-full justify-center" variant="primary" icon={Wand2} disabled={!host.online || running || selected.size === 0 || !userOk} onClick={() => setConfirm(true)}>
            Appliquer la sélection
          </Button>
        )}
        <p className="text-xs text-muted">
          {host.setup ? <>Vérifié {timeAgo(host.setup.checkedAt)}. </> : null}
          Valeurs de la {canManage ? <Link to="/settings?tab=setup" className="text-emerald-400 hover:underline">configuration standard</Link> : 'configuration standard'}.
        </p>
      </div>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={apply}
        loading={busy === 'apply'}
        title={`Standardiser ${host.name}`}
        confirmLabel="Appliquer"
      >
        <p className="mb-2">Options appliquées, avec les valeurs de la configuration standard{user ? <> (utilisateur <b>{user}</b>)</> : ' (root seulement)'} :</p>
        <ul className="list-inside list-disc text-sm text-zinc-300">
          {SETUP_MODULES.filter((m) => selected.has(m)).map((m) => <li key={m}>{setupModuleInfo[m].label}</li>)}
        </ul>
      </ConfirmModal>
    </Panel>
  );
}
