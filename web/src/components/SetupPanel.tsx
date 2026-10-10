import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { RefreshCw, Save, Wand2 } from 'lucide-react';
import { api, SETUP_OPTIONS, type Host, type SetupOption, type SetupOptions, type SetupOverride, type SetupOverrides, type SetupState } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { describeValue, hostHasUser, isListOption, sectionIcons, setupOptionInfo, setupSections, showSetup, type SetupSection } from '../lib/setup';
import { useRunBulk, useUpdateHostCache } from '../lib/queries';
import { useToast } from '../lib/toast';
import { ListInput, OptionEditor, OptionNotes } from './SetupFields';
import { Badge, Button, Modal, Spinner, Tag, VerticalTabs } from './ui';

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

// Standardisation of one host, in vertical tabs (system, root, user): for each option the standard value, a value of its
// own, the standard list plus additions, or not managed; and the conformity of each one.
export function SetupModal({ host, open, onClose, running, onStarted }: { host: Host; open: boolean; onClose: () => void; running: boolean; onStarted: (jobId: string) => void }) {
  const { canWrite, canManage } = useMe();
  const toast = useToast();
  const updateHost = useUpdateHostCache();
  const { data: standard } = useQuery({ queryKey: ['setup'], queryFn: api.setupStandard, enabled: open });
  const [draft, setDraft] = useState<SetupOverrides | null>(null);
  const [busy, setBusy] = useState<'save' | 'apply' | 'check' | null>(null);
  const [tab, setTab] = useState<SetupSection>('system');

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

  // options that differ from the values of the host, per section
  const sectionDrift = (sec: (typeof setupSections)[number]) =>
    sec.options.filter((k) => isManaged(standard.options, overrides, k) && ['drift', 'error'].includes(checks.get(k)?.state ?? '')).length;
  const tabs = setupSections.map((sec) => {
    const n = sectionDrift(sec);
    return { id: sec.id, label: sec.title, icon: sectionIcons[sec.id], count: n ? <Badge tone="warn">{n}</Badge> : undefined };
  });
  const sec = setupSections.find((x) => x.id === tab)!;

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
        <div className="overflow-hidden rounded-md border border-line">
          <VerticalTabs tabs={tabs} value={tab} onChange={setTab} bodyClassName="px-4 py-2">
            <p className="pt-2 text-xs text-muted">{sec.hint}</p>
            <ul>
              {sec.id === 'user' ? (
                <>
                  {row('user')}
                  {withUser ? sec.options.filter((k) => k !== 'user').map(row) : <li className="py-3 text-xs text-muted">Aucun utilisateur sur cet hôte : seul root est configuré.</li>}
                </>
              ) : (
                sec.options.map(row)
              )}
            </ul>
          </VerticalTabs>
        </div>
        <p className="text-xs text-muted">
          {host.setup ? <>Vérifié {timeAgo(host.setup.checkedAt)}. </> : null}
          Valeurs standard : {canManage ? <Link to="/settings?tab=setup" className="text-emerald-400 hover:underline">configuration standard</Link> : 'configuration standard'}.
        </p>
      </div>
    </Modal>
  );
}

// Standardisation of several hosts (Hôtes, selection): the chosen options of the standard go back to
// the standard on every host (their own values are dropped), then they are applied.
export function BulkSetupModal({ hosts, open, onClose }: { hosts: Host[]; open: boolean; onClose: () => void }) {
  const bulk = useRunBulk();
  const { data: standard } = useQuery({ queryKey: ['setup'], queryFn: api.setupStandard, enabled: open });
  const [draft, setDraft] = useState<Set<SetupOption> | null>(null);
  if (!open) return null;
  const close = () => {
    setDraft(null);
    onClose();
  };
  const targets = hosts.filter((h) => h.capabilities.includes('setup'));
  const skipped = hosts.length - targets.length;
  // only the options of the standard, all pre-checked
  const inStandard = SETUP_OPTIONS.filter((k) => standard?.options[k].enabled);
  const selected = draft ?? new Set(inStandard);
  const toggle = (k: SetupOption, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(k);
    else next.delete(k);
    setDraft(next);
  };
  const chosen = inStandard.filter((k) => selected.has(k));
  // own values of the hosts that the application replaces
  const replaced = targets
    .map((h) => ({ host: h, options: chosen.filter((k) => h.setupOverrides[k]) }))
    .filter((r) => r.options.length);

  return (
    <Modal
      open
      onClose={close}
      wide
      title={`Standardiser ${targets.length} hôte(s)`}
      footer={
        <>
          <Button onClick={close}>Annuler</Button>
          <Button
            variant="primary"
            icon={Wand2}
            loading={bulk.isPending}
            disabled={!standard || !chosen.length || !targets.length}
            onClick={() => bulk.mutate({ hostIds: targets.map((h) => h.id), action: 'setup_apply', options: chosen }, { onSuccess: close })}
          >
            Appliquer {chosen.length} option(s)
          </Button>
        </>
      }
    >
      {!standard ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap gap-1.5">{targets.map((h) => <Tag key={h.id}>{h.name}</Tag>)}</div>
          {skipped > 0 && <p className="text-xs text-muted">{skipped} hôte(s) ignoré(s) : standardisation indisponible (Debian / Ubuntu, agent à jour).</p>}
          <p className="text-xs text-muted">
            Les options cochées repassent au standard sur chaque hôte : leurs valeurs propres sont supprimées, puis le standard est appliqué. Seules les
            options du standard sont proposées.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {setupSections.map((s) => (
              <section key={s.id}>
                <h3 className="mb-1 border-b border-line pb-1 text-xs font-medium uppercase tracking-wide text-muted">{s.title}</h3>
                {s.options.filter((k) => standard.options[k].enabled).map((k) => (
                  <label key={k} className="flex cursor-pointer items-center gap-2 py-1 text-zinc-200">
                    <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={selected.has(k)} onChange={(e) => toggle(k, e.target.checked)} />
                    {setupOptionInfo[k].label}
                  </label>
                ))}
                {!s.options.some((k) => standard.options[k].enabled) && <p className="py-1 text-xs text-zinc-600">Aucune option dans le standard.</p>}
              </section>
            ))}
          </div>
          {replaced.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
              <p className="mb-1 font-medium">Valeurs propres remplacées par le standard :</p>
              <ul className="space-y-0.5">
                {replaced.map((r) => (
                  <li key={r.host.id}>
                    {r.host.name} : {r.options.map((k) => `${setupOptionInfo[k].label}${k.startsWith('user') ? ' (utilisateur)' : k.startsWith('root') ? ' (root)' : ''}`).join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
