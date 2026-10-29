import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Globe, Pencil, Play, Plus, Save, Trash2 } from 'lucide-react';
import { api, type Equipment, type Host, type Probe, type ProbeInput, type ProbeMeasure, type ProbeTarget, type ProbeType } from '../lib/api';
import { useMe } from '../lib/auth';
import { elapsed } from '../lib/format';
import { useMqttBrokers, useProbeDays, useProbeRecent, useProbes } from '../lib/queries';
import { stepStates } from '../lib/steps';
import type { Tone } from '../lib/status';
import { useToast } from '../lib/toast';
import { CheckLine, Step, Steps, type CheckState } from './PbsDialog';
import { field } from './ProxmoxServer';
import { TYPES, targetText } from '../lib/probes';
import { Badge, Button, ConfirmModal, IconGroup, Modal, Panel, ResponsiveList, Spinner } from './ui';

const stateMeta: Record<Probe['state'], { label: string; tone: Tone }> = {
  up: { label: 'up', tone: 'ok' },
  down: { label: 'down', tone: 'bad' },
  // the measure is impossible (broker unreachable...): grey, the service is not judged
  unknown: { label: 'inconnu', tone: 'neutral' },
};

// Type of a probe as a small coloured label, one colour per type.
const typeTint: Record<ProbeType, string> = {
  mqtt: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  ping: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  tcp: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  http: 'bg-teal-500/15 text-teal-300 ring-teal-500/30',
};

export function ProbeTypeLabel({ type }: { type: ProbeType }) {
  return <span className={clsx('shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset', typeTint[type])}>{TYPES.find((t) => t.id === type)?.label}</span>;
}

export function StateBadge({ p }: { p: Probe }) {
  const m = stateMeta[p.state];
  return <Badge tone={m.tone}>{m.label}{p.state === 'up' && p.latencyMs ? ` · ${p.latencyMs} ms` : ''}</Badge>;
}

// What the probes are attached to: a host (a probe may follow one of its Docker stacks) or an equipment (its IP is
// the address offered to a new probe).
// One block per day over the last 30 days, like the backups: green when every measure of the day answered, orange under 1 %
// of failures, red beyond; neutral when nothing was measured (probe younger than the day, hub stopped).
const DAYS = 30;
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function ProbeTimeline({ probeId, className }: { probeId: string; className?: string }) {
  const { data } = useProbeDays();
  const mine = data?.get(probeId);
  const today = new Date();
  const cells = Array.from({ length: DAYS }, (_, i) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (DAYS - 1 - i));
    const d = mine?.get(dayKey(date));
    const total = d ? d.up + d.down + d.unknown : 0;
    const known = d ? d.up + d.down : 0;
    const down = d && known ? d.down / known : 0;
    const cls = !d || !total ? 'bg-raised' : !known ? 'bg-zinc-600' : d.down === 0 ? 'bg-emerald-500' : down < 0.01 ? 'bg-amber-500' : 'bg-red-500';
    const text = !d || !total ? 'aucune mesure' : `${known ? `${Math.round((1 - down) * 1000) / 10} % disponible` : 'mesure impossible'} · ${total} mesure${total > 1 ? 's' : ''}${d.down ? `, ${d.down} en échec` : ''}`;
    return { key: dayKey(date), cls, title: `${date.toLocaleDateString('fr-FR')} : ${text}` };
  });
  return (
    <div className={clsx('flex gap-[2px]', className ?? 'w-full')} aria-label="État de la sonde sur les 30 derniers jours">
      {cells.map((c) => <span key={c.key} title={c.title} className={clsx('h-3.5 min-w-0 flex-1 rounded-[2px]', c.cls)} />)}
    </div>
  );
}

// One block per measure over the last hour: green up, red down, grey when the measure was impossible. Beyond MAX_BLOCKS
// measures (short interval, narrow card) neighbours are merged so a block stays readable; a merged block shows its worst state.
const MAX_BLOCKS = 60;
const SEVERITY = { up: 0, unknown: 1, down: 2 } as const;
const TINT = { up: 'bg-emerald-500', down: 'bg-red-500', unknown: 'bg-zinc-600' };
const LABEL = { up: 'up', down: 'down', unknown: 'mesure impossible' };

export function ProbeRecent({ probeId, className }: { probeId: string; className?: string }) {
  const { data } = useProbeRecent();
  const mine = data?.get(probeId) ?? [];
  const size = Math.ceil(mine.length / MAX_BLOCKS) || 1;
  const blocks = Array.from({ length: Math.ceil(mine.length / size) }, (_, i) => {
    const group = mine.slice(i * size, (i + 1) * size);
    const state = group.reduce<ProbeMeasure['state']>((w, m) => (SEVERITY[m.state] > SEVERITY[w] ? m.state : w), 'up');
    const time = new Date(group[0].at).toLocaleTimeString('fr-FR');
    return { key: group[0].at, state, title: group.length > 1 ? `${time} : ${group.length} mesures, ${group.filter((m) => m.state !== 'up').length} en échec ou impossibles` : `${time} : ${LABEL[state]}` };
  });
  return (
    <div className={clsx('flex h-3.5 min-w-0 gap-[2px]', className ?? 'w-full')} aria-label="Mesures de la sonde sur la dernière heure">
      {blocks.length ? blocks.map((b) => <span key={b.key} title={b.title} className={clsx('min-w-0 flex-1 rounded-[2px]', TINT[b.state])} />) : <span className="flex-1 rounded-[2px] bg-raised" title="aucune mesure sur la dernière heure" />}
    </div>
  );
}

export type ProbeOwner = { kind: 'host'; host: Host } | { kind: 'equipment'; equipment: Equipment };
const ownerOf = (o: ProbeOwner) => (o.kind === 'host' ? o.host : o.equipment);

// Test, edit and delete buttons of a probe, with their dialogs (its page, or the Probes page).
export function ProbeActions({ probe: p, owner }: { probe: Probe; owner: ProbeOwner }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState<'test' | 'remove' | null>(null);

  const test = async () => {
    setBusy('test');
    try {
      const m = await api.testProbe(p.target, p.timeoutSec);
      const text = m.state === 'up' ? `${p.name} : up${m.latencyMs ? ` en ${m.latencyMs} ms` : ''}` : `${p.name} : ${m.state === 'down' ? 'down' : 'mesure impossible'}${m.message ? ` (${m.message})` : ''}`;
      if (m.state === 'up') toast.success(text);
      else toast.error(text);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('remove');
    try {
      await api.deleteProbe(p.id);
      await qc.invalidateQueries({ queryKey: ['probes'] });
      toast.success(`Sonde ${p.name} supprimée`);
      setRemoving(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <IconGroup
        actions={[
          { icon: Play, title: 'Tester', loading: busy === 'test', onClick: () => void test() },
          { icon: Pencil, title: `Modifier ${p.name}`, onClick: () => setEditing(true) },
          { icon: Trash2, title: `Supprimer ${p.name}`, danger: true, onClick: () => setRemoving(true) },
        ]}
      />
      {editing && <ProbeModal owner={owner} probe={p} onClose={() => setEditing(false)} />}
      <ConfirmModal open={removing} onClose={() => setRemoving(false)} onConfirm={() => void remove()} title="Supprimer la sonde" confirmLabel="Supprimer" danger loading={busy === 'remove'}>
        La sonde <b>{p.name}</b> ne sera plus mesurée. Son historique dans la frise des alertes est conservé.
      </ConfirmModal>
    </>
  );
}

// Probes of a host or an equipment, on its page: what is seen from outside, on top of what its agent or its source
// reports. Admins edit.
export function ProbesPanel({ owner }: { owner: ProbeOwner }) {
  const { canManage } = useMe();
  const { data: probes, isLoading } = useProbes(owner.kind, ownerOf(owner).id);
  const { data: brokers } = useMqttBrokers(canManage);
  const [editing, setEditing] = useState<'new' | null>(null);
  if (!canManage && !probes?.length) return null;

  const brokerName = (id: string) => brokers?.find((b) => b.id === id)?.name ?? id;
  const where = (p: Probe) => (p.target.type === 'mqtt' ? `${brokerName(p.target.brokerId)} · ${targetText(p.target)}` : targetText(p.target));

  return (
    <Panel
      title="Sondes & Services"
      icon={Globe}
      bodyClassName=""
      actions={canManage && <Button size="sm" icon={Plus} onClick={() => setEditing('new')}>Ajouter une sonde</Button>}
    >
      {isLoading ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : !probes?.length ? (
        <p className="p-4 text-sm text-muted">Aucune sonde. Une sonde vérifie, depuis le hub, que {owner.kind === 'host' ? 'le service rendu par cet hôte' : 'cet équipement'} répond.</p>
      ) : (
        <>
          <ResponsiveList mode="mobile">
            {probes.map((p) => (
              <article key={p.id} className="min-w-0 space-y-2 p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-zinc-100" title={p.name}>{p.name}</span>
                  <StateBadge p={p} />
                </div>
                <p className="break-all font-mono text-xs text-muted">{where(p)}</p>
                <ProbeRecent probeId={p.id} />
                {p.message && p.state !== 'up' && <p className="break-words text-xs text-amber-300">{p.message}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>{p.stack ? `Stack ${p.stack} · ` : ''}{p.since ? `depuis ${elapsed(p.since)}` : 'pas encore mesurée'}</span>
                  {canManage && <ProbeActions probe={p} owner={owner} />}
                </div>
              </article>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="th pl-4">Sonde</th>
                  <th className="th hidden 2xl:table-cell">Type</th>
                  <th className="th">Cible</th>
                  <th className="th">État</th>
                  <th className="th hidden 2xl:table-cell">Depuis</th>
                  <th className="th">Dernière heure</th>
                  {canManage && <th className="th pr-4 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {probes.map((p) => (
                  <tr key={p.id} className="hover:bg-raised/40">
                    <td className="td pl-4">
                      <span className="font-medium text-zinc-100">{p.name}</span>
                      {p.stack && <Badge className="ml-2">{p.stack}</Badge>}
                    </td>
                    <td className="td hidden text-muted 2xl:table-cell">{TYPES.find((t) => t.id === p.target.type)?.label}</td>
                    <td className="td max-w-[180px] 2xl:max-w-[320px]"><span className="block truncate font-mono text-xs text-zinc-300" title={where(p)}>{where(p)}</span></td>
                    <td className="td">
                      <StateBadge p={p} />
                      {p.message && p.state !== 'up' && <p className="mt-0.5 max-w-[260px] truncate text-xs text-amber-300" title={p.message}>{p.message}</p>}
                    </td>
                    <td className="td hidden text-muted 2xl:table-cell">{p.since ? elapsed(p.since) : '—'}</td>
                    <td className="td"><ProbeRecent probeId={p.id} className="w-full min-w-[6rem] max-w-44" /></td>
                    {canManage && <td className="td pr-4"><div className="flex justify-end"><ProbeActions probe={p} owner={owner} /></div></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveList>
        </>
      )}
      {editing === 'new' && <ProbeModal owner={owner} probe={null} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

interface Form {
  name: string;
  type: ProbeType;
  stack: string;
  brokerId: string;
  topic: string;
  contains: string;
  host: string;
  port: string;
  url: string;
  status: string;
  keyword: string;
  insecure: boolean;
  intervalSec: string;
  timeoutSec: string;
  retries: string;
}

// address: offered to a new ping or TCP probe (IP of an equipment)
function formOf(p: Probe | null, address = ''): Form {
  const t = p?.target;
  return {
    name: p?.name ?? '',
    type: t?.type ?? 'mqtt',
    stack: p?.stack ?? '',
    brokerId: t?.type === 'mqtt' ? t.brokerId : '',
    topic: t?.type === 'mqtt' ? t.topic : '',
    contains: t?.type === 'mqtt' ? (t.contains ?? '') : '',
    host: t?.type === 'ping' || t?.type === 'tcp' ? t.host : p ? '' : address,
    port: t?.type === 'tcp' ? String(t.port) : '',
    url: t?.type === 'http' ? t.url : '',
    status: t?.type === 'http' && t.status ? String(t.status) : '',
    keyword: t?.type === 'http' ? (t.keyword ?? '') : '',
    insecure: t?.type === 'http' ? !!t.insecure : false,
    intervalSec: String(p?.intervalSec ?? 60),
    timeoutSec: String(p?.timeoutSec ?? 10),
    retries: String(p?.retries ?? 0),
  };
}

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : NaN);

function targetOf(f: Form): ProbeTarget | null {
  switch (f.type) {
    case 'mqtt':
      return f.brokerId && f.topic.trim() && !/[+#]/.test(f.topic) ? { type: 'mqtt', brokerId: f.brokerId, topic: f.topic.trim(), ...(f.contains ? { contains: f.contains } : {}) } : null;
    case 'ping':
      return HOST_RE.test(f.host.trim()) ? { type: 'ping', host: f.host.trim() } : null;
    case 'tcp': {
      const port = int(f.port);
      return HOST_RE.test(f.host.trim()) && port >= 1 && port <= 65535 ? { type: 'tcp', host: f.host.trim(), port } : null;
    }
    case 'http': {
      const status = f.status.trim() ? int(f.status) : undefined;
      if (status !== undefined && !(status >= 100 && status <= 599)) return null;
      return /^https?:\/\/\S+$/.test(f.url.trim()) ? { type: 'http', url: f.url.trim(), ...(status ? { status } : {}), ...(f.keyword ? { keyword: f.keyword } : {}), ...(f.insecure ? { insecure: true } : {}) } : null;
    }
  }
}

// A probe in four steps (PbsDialog.tsx): type and name, target, options, test. The test measures without saving.
function ProbeModal({ owner, probe, onClose }: { owner: ProbeOwner; probe: Probe | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: brokers } = useMqttBrokers();
  const subject = ownerOf(owner);
  const [initial] = useState(() => formOf(probe, owner.kind === 'equipment' ? (owner.equipment.ip ?? '') : ''));
  const [form, setForm] = useState<Form>(initial);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const set = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setTest(null);
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const target = targetOf(form);
  const interval = int(form.intervalSec);
  const timeout = int(form.timeoutSec);
  const retries = int(form.retries);
  const nameOk = form.name.trim().length > 0 && form.name.trim().length <= 64;
  const optionsOk = interval >= 10 && interval <= 3600 && timeout >= 1 && timeout <= 60 && timeout <= interval && retries >= 0 && retries <= 3;
  const input = (): ProbeInput => ({ name: form.name.trim(), ...(form.stack ? { stack: form.stack } : {}), target: target!, intervalSec: interval, timeoutSec: timeout, retries });

  const runTest = async () => {
    if (!target || !optionsOk) return;
    setBusy('test');
    setTest(null);
    try {
      const m = await api.testProbe(target, timeout);
      setTest(
        m.state === 'up'
          ? { level: 'ok', title: 'up', detail: m.latencyMs ? `répond en ${m.latencyMs} ms` : undefined }
          : m.state === 'down'
            ? { level: 'error', title: 'down', detail: m.message }
            : { level: 'warn', title: 'Mesure impossible', detail: m.message },
      );
    } catch (err) {
      setTest({ level: 'error', title: 'Échec du test', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      if (probe) await api.updateProbe(probe.id, input());
      else await api.createProbe(owner.kind, subject.id, input());
      await qc.invalidateQueries({ queryKey: ['probes'] });
      toast.success(probe ? `Sonde ${form.name.trim()} modifiée` : `Sonde ${form.name.trim()} ajoutée`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const [typeState, targetState, optionsState, testState] = stepStates([nameOk, !!target, !!target && optionsOk, test?.level === 'ok']);
  const stacks = owner.kind === 'host' ? (owner.host.docker?.stacks ?? []) : null;
  const hint = TYPES.find((t) => t.id === form.type)?.hint;

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={probe ? `Modifier la sonde · ${subject.name}` : `Ajouter une sonde · ${subject.name}`}
        footer={
          <>
            <Button disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || !nameOk || !target || !optionsOk || (!!probe && !dirty)} onClick={() => void save()}>
              {probe ? 'Enregistrer' : 'Ajouter la sonde'}
            </Button>
          </>
        }
      >
        <Steps fill>
          <Step n={1} title="Type et nom" state={typeState} intro="Ce que la sonde vérifie, et comment elle s'appelle.">
            <label className="block">
              <span className={field}>Nom</span>
              <input className="input" autoFocus maxLength={64} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="DNS AdGuard, Bridge Zigbee2MQTT…" />
            </label>
            <fieldset className="space-y-1.5">
              <legend className={field}>Type</legend>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Type de sonde">
                {TYPES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={form.type === t.id}
                    onClick={() => set({ type: t.id })}
                    className={`h-10 rounded-md border px-3 text-sm md:h-8 ${form.type === t.id ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-line bg-raised text-zinc-300 hover:bg-zinc-800'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted">{hint}</p>
            </fieldset>
          </Step>
          <Step n={2} title="Cible" state={targetState} intro="Ce que le hub mesure.">
            {form.type === 'mqtt' && (
              <>
                <label className="block">
                  <span className={field}>Broker</span>
                  <select className="input" value={form.brokerId} onChange={(e) => set({ brokerId: e.target.value })}>
                    <option value="">Choisir un broker…</option>
                    {brokers?.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.url}</option>)}
                  </select>
                  {brokers && brokers.length === 0 && (
                    <button type="button" className="mt-1 text-xs text-emerald-400 hover:underline" onClick={() => navigate('/settings?tab=roles')}>
                      Aucun broker : en déclarer un dans Paramètres › Rôles
                    </button>
                  )}
                </label>
                <label className="block">
                  <span className={field}>Topic</span>
                  <input className="input font-mono text-xs" value={form.topic} onChange={(e) => set({ topic: e.target.value })} placeholder="zigbee2mqtt/bridge/state" spellCheck={false} />
                  <span className="mt-1 block text-xs text-muted">Sans joker (+ ni #)</span>
                </label>
                <label className="block">
                  <span className={field}>Le payload contient</span>
                  <input className="input font-mono text-xs" value={form.contains} onChange={(e) => set({ contains: e.target.value })} placeholder="online" spellCheck={false} />
                  <span className="mt-1 block text-xs text-muted">Vide : un message reçu dans le délai suffit</span>
                </label>
              </>
            )}
            {(form.type === 'ping' || form.type === 'tcp') && (
              <label className="block">
                <span className={field}>Adresse</span>
                <input className="input font-mono text-xs" value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="192.168.20.253" spellCheck={false} />
              </label>
            )}
            {form.type === 'tcp' && (
              <label className="block">
                <span className={field}>Port</span>
                <input className="input font-mono text-xs" inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value })} placeholder="53" />
              </label>
            )}
            {form.type === 'http' && (
              <>
                <label className="block">
                  <span className={field}>URL</span>
                  <input className="input font-mono text-xs" value={form.url} onChange={(e) => set({ url: e.target.value.trim() })} placeholder="https://nextcloud.example.org/status.php" spellCheck={false} />
                </label>
                <label className="block">
                  <span className={field}>Code attendu</span>
                  <input className="input font-mono text-xs" inputMode="numeric" value={form.status} onChange={(e) => set({ status: e.target.value })} placeholder="2xx par défaut" />
                </label>
                <label className="block">
                  <span className={field}>Mot-clé dans la réponse</span>
                  <input className="input" value={form.keyword} onChange={(e) => set({ keyword: e.target.value })} placeholder="facultatif" />
                </label>
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={form.insecure} onChange={(e) => set({ insecure: e.target.checked })} className="accent-emerald-500" />
                  Ne pas vérifier le certificat (auto-signé)
                </label>
              </>
            )}
          </Step>
          <Step n={3} title="Options" state={optionsState} intro="Facultatif, modifiable ensuite.">
            {stacks && (
              <label className="block">
                <span className={field}>Stack Docker</span>
                <select className="input" value={form.stack} onChange={(e) => set({ stack: e.target.value })}>
                  <option value="">Aucune (l'hôte)</option>
                  {stacks.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                  {form.stack && !stacks.some((s) => s.name === form.stack) && <option value={form.stack}>{form.stack}</option>}
                </select>
                <span className="mt-1 block text-xs text-muted">La sonde suit la stack : elle est supprimée avec elle.</span>
              </label>
            )}
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={field}>Intervalle (s)</span>
                <input className="input" inputMode="numeric" value={form.intervalSec} onChange={(e) => set({ intervalSec: e.target.value })} />
              </label>
              <label className="block">
                <span className={field}>Délai max (s)</span>
                <input className="input" inputMode="numeric" value={form.timeoutSec} onChange={(e) => set({ timeoutSec: e.target.value })} />
              </label>
            </div>
            <label className="block">
              <span className={field}>Nouvelles tentatives avant « down »</span>
              <input className="input" inputMode="numeric" value={form.retries} onChange={(e) => set({ retries: e.target.value })} />
            </label>
            {!optionsOk && <p className="text-xs text-amber-400">Intervalle de 10 à 3600 s, délai de 1 à 60 s et pas plus long que l'intervalle, 0 à 3 tentatives.</p>}
            <p className="text-xs text-muted">Exécutée depuis : le hub (seul choix pour l'instant).</p>
          </Step>
          <Step
            n={4}
            title="Test"
            state={testState}
            intro="Mesure immédiate depuis le hub, rien n'est enregistré. Une sonde peut être ajoutée sans test, par exemple pour un service éteint."
            footer={
              <Button className="w-full" variant={testState === 'active' ? 'primary' : 'secondary'} icon={Play} loading={busy === 'test'} disabled={busy !== null || !target || !optionsOk} onClick={() => void runTest()}>
                {test ? 'Tester à nouveau' : 'Tester la sonde'}
              </Button>
            }
          >
            <CheckLine label="État de la sonde" check={test} idle={target ? targetText(target) : undefined} />
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        La sonde modifiée ne sera pas enregistrée.
      </ConfirmModal>
    </>
  );
}
