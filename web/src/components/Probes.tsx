import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Globe, Pencil, Play, Plus, Save, Trash2 } from 'lucide-react';
import { api, type Host, type Probe, type ProbeInput, type ProbeTarget, type ProbeType } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { useHostProbes, useMqttBrokers } from '../lib/queries';
import { stepStates } from '../lib/steps';
import type { Tone } from '../lib/status';
import { useToast } from '../lib/toast';
import { CheckLine, Step, Steps, type CheckState } from './PbsDialog';
import { field } from './ProxmoxServer';
import { Badge, Button, ConfirmModal, Modal, Panel, ResponsiveList, Spinner } from './ui';

const TYPES: { id: ProbeType; label: string; hint: string }[] = [
  { id: 'mqtt', label: 'MQTT', hint: "Le payload d'un topic contient une valeur, ou un message arrive dans le délai." },
  { id: 'ping', label: 'Ping', hint: "L'adresse répond au ping depuis le hub." },
  { id: 'tcp', label: 'Port TCP', hint: 'Un port accepte la connexion (DNS, SSH, base de données…).' },
  { id: 'http', label: 'HTTP(S)', hint: 'Une URL répond avec le bon code, et un mot-clé dans la réponse si demandé.' },
];

const stateMeta: Record<Probe['state'], { label: string; tone: Tone }> = {
  up: { label: 'up', tone: 'ok' },
  down: { label: 'down', tone: 'bad' },
  // the measure is impossible (broker unreachable...): grey, the service is not judged
  unknown: { label: 'inconnu', tone: 'neutral' },
};

function targetText(t: ProbeTarget) {
  switch (t.type) {
    case 'mqtt': return `${t.topic}${t.contains ? ` ≙ ${t.contains}` : ' (message reçu)'}`;
    case 'ping': return t.host;
    case 'tcp': return `${t.host}:${t.port}`;
    case 'http': return `${t.url}${t.status ? ` → ${t.status}` : ''}${t.keyword ? ` ∋ ${t.keyword}` : ''}`;
  }
}

function StateBadge({ p }: { p: Probe }) {
  const m = stateMeta[p.state];
  return <Badge tone={m.tone}>{m.label}{p.state === 'up' && p.latencyMs ? ` · ${p.latencyMs} ms` : ''}</Badge>;
}

// Probes of a host, on its detail page: what is seen from outside, on top of what its agent reports. Admins edit.
export function ProbesPanel({ host }: { host: Host }) {
  const { canManage } = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: probes, isLoading } = useHostProbes(host.id);
  const { data: brokers } = useMqttBrokers(canManage);
  const [editing, setEditing] = useState<Probe | 'new' | null>(null);
  const [removing, setRemoving] = useState<Probe | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!canManage && !probes?.length) return null;

  const brokerName = (id: string) => brokers?.find((b) => b.id === id)?.name ?? id;
  const where = (p: Probe) => (p.target.type === 'mqtt' ? `${brokerName(p.target.brokerId)} · ${targetText(p.target)}` : targetText(p.target));

  const test = async (p: Probe) => {
    setBusy(`test:${p.id}`);
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
    if (!removing) return;
    setBusy('remove');
    try {
      await api.deleteProbe(removing.id);
      await qc.invalidateQueries({ queryKey: ['probes'] });
      toast.success(`Sonde ${removing.name} supprimée`);
      setRemoving(null);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const actions = (p: Probe) =>
    canManage && (
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        <Button size="sm" icon={Play} loading={busy === `test:${p.id}`} onClick={() => void test(p)}>Tester</Button>
        <Button size="sm" icon={Pencil} aria-label={`Modifier ${p.name}`} title="Modifier" onClick={() => setEditing(p)} />
        <Button size="sm" variant="danger" icon={Trash2} aria-label={`Supprimer ${p.name}`} title="Supprimer" onClick={() => setRemoving(p)} />
      </div>
    );

  return (
    <Panel
      title={<>Sondes <span className="text-muted">({probes?.length ?? 0})</span></>}
      icon={Globe}
      bodyClassName=""
      actions={canManage && <Button size="sm" icon={Plus} onClick={() => setEditing('new')}>Ajouter une sonde</Button>}
    >
      {isLoading ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : !probes?.length ? (
        <p className="p-4 text-sm text-muted">Aucune sonde. Une sonde vérifie, depuis le hub, que le service rendu par cet hôte répond.</p>
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
                {p.message && p.state !== 'up' && <p className="break-words text-xs text-amber-300">{p.message}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>{p.stack ? `Stack ${p.stack} · ` : ''}{p.since ? `depuis ${timeAgo(p.since)}` : 'pas encore mesurée'}</span>
                  {actions(p)}
                </div>
              </article>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Sonde</th>
                  <th className="th">Type</th>
                  <th className="th">Cible</th>
                  <th className="th">État</th>
                  <th className="th">Depuis</th>
                  {canManage && <th className="th text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {probes.map((p) => (
                  <tr key={p.id} className="hover:bg-raised/40">
                    <td className="td">
                      <span className="font-medium text-zinc-100">{p.name}</span>
                      {p.stack && <Badge className="ml-2">{p.stack}</Badge>}
                    </td>
                    <td className="td text-muted">{TYPES.find((t) => t.id === p.target.type)?.label}</td>
                    <td className="td max-w-[320px]"><span className="block truncate font-mono text-xs text-zinc-300" title={where(p)}>{where(p)}</span></td>
                    <td className="td">
                      <StateBadge p={p} />
                      {p.message && p.state !== 'up' && <p className="mt-0.5 max-w-[260px] truncate text-xs text-amber-300" title={p.message}>{p.message}</p>}
                    </td>
                    <td className="td text-muted">{p.since ? timeAgo(p.since) : '—'}</td>
                    {canManage && <td className="td">{actions(p)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveList>
        </>
      )}
      {editing && <ProbeModal host={host} probe={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()} title="Supprimer la sonde" confirmLabel="Supprimer" danger loading={busy === 'remove'}>
        La sonde <b>{removing?.name}</b> ne sera plus mesurée. Son historique dans la frise des alertes est conservé.
      </ConfirmModal>
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

function formOf(p: Probe | null): Form {
  const t = p?.target;
  return {
    name: p?.name ?? '',
    type: t?.type ?? 'mqtt',
    stack: p?.stack ?? '',
    brokerId: t?.type === 'mqtt' ? t.brokerId : '',
    topic: t?.type === 'mqtt' ? t.topic : '',
    contains: t?.type === 'mqtt' ? (t.contains ?? '') : '',
    host: t?.type === 'ping' || t?.type === 'tcp' ? t.host : '',
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
function ProbeModal({ host, probe, onClose }: { host: Host; probe: Probe | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: brokers } = useMqttBrokers();
  const [initial] = useState(() => formOf(probe));
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
      else await api.createProbe(host.id, input());
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
  const stacks = host.docker?.stacks ?? [];
  const hint = TYPES.find((t) => t.id === form.type)?.hint;

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={probe ? `Modifier la sonde · ${host.name}` : `Ajouter une sonde · ${host.name}`}
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
                    <button type="button" className="mt-1 text-xs text-emerald-400 hover:underline" onClick={() => navigate('/settings?tab=probes')}>
                      Aucun broker : en ajouter un dans Paramètres › Sondes
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
            <label className="block">
              <span className={field}>Stack Docker</span>
              <select className="input" value={form.stack} onChange={(e) => set({ stack: e.target.value })}>
                <option value="">Aucune (l'hôte)</option>
                {stacks.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                {form.stack && !stacks.some((s) => s.name === form.stack) && <option value={form.stack}>{form.stack}</option>}
              </select>
              <span className="mt-1 block text-xs text-muted">La sonde suit la stack : elle est supprimée avec elle.</span>
            </label>
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
