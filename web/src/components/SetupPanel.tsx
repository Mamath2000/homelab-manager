import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { RefreshCw, Save, Wand2 } from 'lucide-react';
import { api, type Host, type SetupOption, type SetupOptions, type SetupOverride, type SetupOverrides, type SetupState } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { describeValue, hostHasUser, isListOption, setupOptionInfo, setupSections, showSetup, type SetupSection } from '../lib/setup';
import { useUpdateHostCache } from '../lib/queries';
import { useToast } from '../lib/toast';
import { ListInput, OptionEditor, OptionNotes } from './SetupFields';
import { Badge, Button, Modal, Spinner } from './ui';

function StateBadge({ check, managed }: { check?: SetupState['modules'][number]; managed: boolean }) {
  if (!managed) return <span className="text-xs text-zinc-600">non géré</span>;
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

type Mode = 'standard' | SetupOverride<SetupOption>['mode'];

// Whether an option is applied on the host: its standard state, or its override.
const isManaged = (options: SetupOptions, overrides: SetupOverrides, k: SetupOption) => {
  const o = overrides[k];
  if (k.startsWith('user_') && !hostHasUser(options, overrides)) return false;
  return o ? o.mode !== 'off' : options[k].enabled;
};

// One option of a host: standard value, own value, standard list plus additions, or not managed.
function OptionRow<K extends SetupOption>({ k, std, override, onChange, check, managed, disabled }: {
  k: K;
  std: SetupOptions[K];
  override: SetupOverride<K> | undefined;
  onChange: (o: SetupOverride<K> | undefined) => void;
  check?: SetupState['modules'][number];
  managed: boolean;
  disabled: boolean;
}) {
  const mode: Mode = override?.mode ?? 'standard';
  const setMode = (m: Mode) => {
    if (m === 'standard') onChange(undefined);
    else if (m === 'off') onChange({ mode: 'off' });
    else if (m === 'extra') onChange({ mode: 'extra', add: [] });
    else onChange({ mode: 'custom', value: structuredClone(std.value) });
  };
  return (
    <li className="border-b border-line/60 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-zinc-200">{setupOptionInfo[k].label}</span>
        <div className="flex items-center gap-2">
          <StateBadge check={check} managed={managed} />
          <select className="input h-8 w-auto py-0 text-xs" value={mode} disabled={disabled} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="standard">Standard ({std.enabled ? describeValue(k, std.value) : 'non géré'})</option>
            <option value="custom">Valeur propre</option>
            {isListOption(k) && <option value="extra">Standard + ajouts</option>}
            <option value="off">Non géré</option>
          </select>
        </div>
      </div>
      {check?.detail && check.state !== 'ok' && managed ? (
        <p className="mt-0.5 truncate font-mono text-[11px] text-amber-200/80" title={check.detail}>{check.detail}</p>
      ) : (
        <p className="mt-0.5 text-xs text-zinc-500">{setupOptionInfo[k].hint}</p>
      )}
      {!override && std.enabled && (
        <div className="mt-2 opacity-60" title="Valeur standard (Paramètres › Standardisation)">
          <OptionEditor option={k} value={std.value} onChange={() => {}} disabled />
        </div>
      )}
      {override?.mode === 'custom' && (
        <div className="mt-2">
          <OptionEditor option={k} value={override.value} onChange={(value) => onChange({ mode: 'custom', value })} disabled={disabled} />
          <OptionNotes option={k} value={override.value} />
        </div>
      )}
      {override?.mode === 'extra' && (
        <div className="mt-2">
          {std.enabled && (
            <div className="mb-2 opacity-60" title="Liste standard (Paramètres › Standardisation)">
              <OptionEditor option={k} value={std.value} onChange={() => {}} disabled />
            </div>
          )}
          <span className="mb-1 block text-xs text-muted">En plus de la liste standard{std.enabled ? '' : ' (non gérée)'} :</span>
          <ListInput value={override.add} onChange={(add) => onChange({ mode: 'extra', add })} lines={k !== 'packages'} disabled={disabled} />
        </div>
      )}
    </li>
  );
}

// Standardisation of one host, in three sections: for each option the standard value, a value of its
// own, the standard list plus additions, or not managed; and the conformity of each one.
export function SetupModal({ host, open, onClose, running, onStarted }: { host: Host; open: boolean; onClose: () => void; running: boolean; onStarted: (jobId: string) => void }) {
  const { canWrite, canManage } = useMe();
  const toast = useToast();
  const updateHost = useUpdateHostCache();
  const { data: standard } = useQuery({ queryKey: ['setup'], queryFn: api.setupStandard, enabled: open });
  const [draft, setDraft] = useState<SetupOverrides | null>(null);
  const [busy, setBusy] = useState<'save' | 'apply' | 'check' | null>(null);

  const close = () => {
    setDraft(null);
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

  const overrides = draft ?? host.setupOverrides;
  const checks = new Map(host.setup?.modules.map((m) => [m.module, m]));
  const setOverride = <K extends SetupOption>(k: K, o: SetupOverride<K> | undefined) => {
    const next = { ...overrides } as Record<string, unknown>;
    if (o) next[k] = o;
    else delete next[k];
    setDraft(next as SetupOverrides);
  };
  const withUser = hostHasUser(standard.options, overrides);

  // saves the host values when they changed; false on error
  const save = async () => {
    if (!draft) return true;
    try {
      updateHost(await api.saveHostSetup(host.id, draft));
      setDraft(null);
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    }
  };
  const saveOnly = async () => {
    setBusy('save');
    if (await save()) {
      toast.success(`Valeurs de ${host.name} enregistrées`);
      close();
    }
    setBusy(null);
  };
  const apply = async () => {
    setBusy('apply');
    try {
      if (!(await save())) return;
      const job = await api.applySetup(host.id);
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
      <Button icon={Save} disabled={!draft} loading={busy === 'save'} onClick={saveOnly}>
        Enregistrer
      </Button>
      <Button variant="primary" icon={Wand2} loading={busy === 'apply'} disabled={!host.online || running} onClick={apply}>
        {draft ? 'Enregistrer et appliquer' : 'Appliquer'}
      </Button>
    </>
  );

  const row = (k: SetupOption) => (
    <OptionRow
      key={k}
      k={k}
      std={standard.options[k] as SetupOptions[typeof k]}
      override={overrides[k] as SetupOverride<typeof k> | undefined}
      onChange={(o) => setOverride(k, o)}
      check={checks.get(k)}
      managed={isManaged(standard.options, overrides, k)}
      disabled={!canWrite}
    />
  );

  const section = (id: SetupSection, listClass = '') => {
    const s = setupSections.find((x) => x.id === id)!;
    return (
      <section className="min-w-0">
        <h3 className="border-b border-line pb-1 text-xs font-medium uppercase tracking-wide text-muted">{s.title}</h3>
        <ul className={listClass}>
          {id === 'user' ? (
            <>
              {row('user')}
              {withUser ? s.options.filter((k) => k !== 'user').map(row) : <li className="py-3 text-xs text-muted">Aucun utilisateur sur cet hôte : seul root est configuré.</li>}
            </>
          ) : (
            s.options.map(row)
          )}
        </ul>
      </section>
    );
  };

  return (
    <Modal
      open
      onClose={close}
      wide="xl"
      title={
        <span className="flex items-center gap-2">
          Standardisation de {host.name}
          {host.setup && (drift ? <Badge tone="warn">{driftLabel(drift)}</Badge> : <Badge tone="ok">conforme</Badge>)}
        </span>
      }
      footer={footer}
    >
      <div className="space-y-4 text-sm">
        {canWrite && (
          <div className="flex justify-end">
            <Button size="sm" icon={RefreshCw} variant="ghost" loading={busy === 'check'} disabled={!host.online} onClick={check}>
              Vérifier
            </Button>
          </div>
        )}
        {/* system on two columns, then root and the user side by side */}
        {section('system', 'grid gap-x-6 md:grid-cols-2 *:border-b-0')}
        <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          {section('root')}
          {section('user')}
        </div>
        <p className="text-xs text-muted">
          {host.setup ? <>Vérifié {timeAgo(host.setup.checkedAt)}. </> : null}
          Valeurs standard : {canManage ? <Link to="/settings?tab=setup" className="text-emerald-400 hover:underline">configuration standard</Link> : 'configuration standard'}.
        </p>
      </div>
    </Modal>
  );
}
