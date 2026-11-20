import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Copy, Cpu, Plus, ScrollText, Trash2 } from 'lucide-react';
import { api, type EsphomeDevice, type EsphomeRoleView, type EsphomeSettings as Settings } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { keys, useSites } from '../lib/queries';
import { roleStatus } from '../lib/roles';
import { useToast } from '../lib/toast';
import { Badge, Button, Checkbox, ConfirmModal, Modal, Panel, Spinner, StatusDot } from './ui';

// Rôles › ESPHome (homelab#352, #358): one esphome role per site, carried by the hub. Its inventory: the devices found on
// its broker as their messages left them (esphome/<unique_id>/LWT, info, log_level).

const QUERY = ['settings', 'esphome'] as const;

// Where the lines of the devices go, and how the writing goes.
function LogsInfo({ data }: { data: Settings }) {
  return (
    <div className="space-y-1 border-b border-line px-4 py-3 text-xs text-muted">
      <p>
        <span className="font-medium text-zinc-100">Serveur de logs</span>{' '}
        {data.logServer ? `le serveur de logs du homelab (${data.logServer})` : <span className="text-amber-300">aucun : les logs des appareils ne peuvent pas être activés (déclarer un rôle Serveur de logs)</span>}
        . Les lignes des appareils dont les logs sont activés y sont écrites par le hub (<code>source=esphome</code>, champ <code>device</code> pour un sous-appareil).
        {data.shipping && <> Écrites depuis le démarrage du hub : {data.shipping.sent}, en attente : {data.shipping.waiting}, perdues : {data.shipping.dropped}.</>}
      </p>
      {data.shipping?.error && <p className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-red-200">Écriture en échec : {data.shipping.error}</p>}
    </div>
  );
}

// The level of the logger of an ESP: the one it reports (log_level), changed at once from the list while it is online
// (until it reboots: the command is not kept). Not the default one: flagged.
function LevelCell({ d, levels, defaultLevel }: { d: EsphomeDevice; levels: string[]; defaultLevel: string }) {
  const toast = useToast();
  // the level asked, shown until the device confirms it on log_level (it answers after the request: refetching at once
  // would give the old level back and the select would snap back to it)
  const [pending, setPending] = useState<string | null>(null);
  // confirmed by the device: done (state adjusted while rendering, not in an effect)
  if (pending !== null && pending === d.level) setPending(null);
  const busy = pending !== null;
  useEffect(() => {
    if (pending === null) return;
    const t = setTimeout(() => {
      toast.error(`${d.name ?? d.uniqueId} n'a pas confirmé le niveau ${pending}`);
      setPending(null);
    }, 10_000);
    return () => clearTimeout(t);
  }, [pending, d.level, d.name, d.uniqueId, toast]);
  const change = async (level: string) => {
    setPending(level);
    try {
      await api.setEsphomeLevel(d.key, level);
    } catch (err) {
      toast.error((err as Error).message);
      setPending(null);
    }
  };
  if (!d.level) return <span className="text-xs text-muted" title="Le package ne publie pas encore esphome/<unique_id>/log_level">—</span>;
  const off = d.level !== defaultLevel;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <select
        className="input py-1 text-xs"
        value={pending ?? d.level}
        disabled={busy || d.lwt !== 'online'}
        title={d.lwt !== 'online' ? 'Hors ligne : la commande serait perdue' : `Changer le niveau jusqu'au prochain redémarrage (démarre à ${defaultLevel})`}
        onChange={(e) => void change(e.target.value)}
        aria-label={`Niveau de log de ${d.name ?? d.uniqueId}`}
      >
        {(levels.includes(d.level) ? levels : [d.level, ...levels]).map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
      {busy && <Spinner className="h-3.5 w-3.5" />}
      {off && <span title={`Pas au niveau par défaut (${defaultLevel}) : revient à ${defaultLevel} au redémarrage`}><Badge tone="warn">hors défaut</Badge></span>}
    </span>
  );
}

// The logs of an ESP: forwarded or not, once it is an equipment (a switch, at once). With them: the last line received.
function LogsCell({ d, canLog }: { d: EsphomeDevice; canLog: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await api.setEsphomeLogs(d.key, on);
      await qc.invalidateQueries({ queryKey: QUERY });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const why = !d.equipment ? "créer d'abord l'équipement" : !canLog ? 'aucun serveur de logs' : null;
  const last = d.logs ? (d.lastLineAt ? `dernière ligne ${timeAgo(d.lastLineAt)}` : 'aucune ligne reçue') : null;
  const name = d.name ?? d.uniqueId;
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={d.logs}
        aria-label={`Logs de ${name}`}
        disabled={busy || (!!why && !d.logs)}
        onClick={() => void toggle(!d.logs)}
        title={d.logs ? `Logs envoyés au serveur (${last}) : cliquer pour arrêter` : (why ?? 'Envoyer les logs au serveur de logs')}
        className={clsx(
          'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
          d.logs ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30' : 'border-line bg-raised/40 text-zinc-500 hover:text-zinc-200',
        )}
      >
        {busy ? <Spinner className="h-3.5 w-3.5" /> : <ScrollText className="h-3.5 w-3.5" />}
        {d.logs ? 'Activé' : 'Désactivé'}
      </button>
      {d.logs && d.equipment && d.name && <Link className="text-xs text-muted underline" to={`/logs?hostname=${encodeURIComponent(d.name)}&source=esphome`}>voir</Link>}
    </span>
  );
}

// The sub-devices of an ESP, one button each, lit while it is an equipment: a click makes it one, a click on a lit one
// removes it (after confirmation: its probes and history go with it). Only once the ESP itself is an equipment.
function SubDevices({ d }: { d: EsphomeDevice }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string; equipmentId: string } | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: QUERY }), qc.invalidateQueries({ queryKey: keys.equipments })]);
  const make = async (id: string) => {
    setBusy(id);
    try {
      await api.createEsphomeEquipments({ key: d.key, devices: [id] });
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(removing.id);
    try {
      await api.deleteEquipment(removing.equipmentId);
      await refresh();
      toast.success(`Équipement ${removing.name} supprimé`);
      setRemoving(null);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {d.devices.map((x) => {
        const eq = d.subEquipments[x.id];
        const name = x.name ?? x.id;
        const why = !d.equipment ? "créer d'abord l'équipement de l'ESP" : null;
        return (
          <button
            key={x.id}
            type="button"
            aria-pressed={!!eq}
            disabled={busy !== null || (!!why && !eq)}
            onClick={() => (eq ? setRemoving({ id: x.id, name, equipmentId: eq.id }) : void make(x.id))}
            title={eq ? `${name} : équipement créé, cliquer pour le supprimer` : (why ?? `Créer l'équipement ${name}`)}
            className={clsx(
              'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-40',
              eq ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30' : 'border-line bg-raised/40 text-zinc-500 hover:text-zinc-200',
            )}
          >
            {busy === x.id ? <Spinner className="h-3 w-3" /> : <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', eq ? 'bg-emerald-400' : 'bg-zinc-600')} aria-hidden="true" />}
            <span className="truncate">{name}</span>
          </button>
        );
      })}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()} title="Supprimer l'équipement" confirmLabel="Supprimer" danger loading={busy !== null}>
        <p>
          Supprimer l'équipement <b>{removing?.name}</b> ? Ses sondes et son historique sont supprimés avec lui ; le sous-appareil reste
          visible ici et peut être recréé.
        </p>
      </ConfirmModal>
    </div>
  );
}

// removes what makes a device followed: its logs are turned off, then the equipments of its sub-devices and its own go
async function removeDevice(d: EsphomeDevice) {
  if (d.logs) await api.setEsphomeLogs(d.key, false);
  for (const sub of Object.values(d.subEquipments)) await api.deleteEquipment(sub.id);
  if (d.equipment) await api.deleteEquipment(d.equipment.id);
}

const lwtTone = (d: EsphomeDevice) => (d.lwt === 'online' ? 'ok' : d.lwt === 'offline' ? 'bad' : 'neutral');
const lwtLabel = (d: EsphomeDevice) => (d.lwt === 'online' ? 'en ligne' : d.lwt === 'offline' ? 'hors ligne' : 'LWT absent');

// The IP, copied with a click (the clipboard API needs a secure context: hidden textarea on plain http LAN)
function CopyIp({ ip }: { ip: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ip);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = ip;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) return toast.error('Copie impossible');
    }
    toast.success(`${ip} copiée`);
  };
  return (
    <button type="button" onClick={() => void copy()} title="Copier l'IP" className="inline-flex items-center gap-1 rounded-sm hover:text-zinc-100 hover:underline">
      {ip}
      <Copy className="h-3 w-3" />
    </button>
  );
}

// a device as a small block, like the hosts of the logs: state and name, what it is, then its controls on one line
function DeviceCard({ d, canLog, levels, defaultLevel, selected, onSelect, onUntrack }: { d: EsphomeDevice; canLog: boolean; levels: string[]; defaultLevel: string; selected: boolean; onSelect: (v: boolean) => void; onUntrack: () => void }) {
  const meta = [d.uniqueId, d.ip, d.version].filter(Boolean).join(' · ');
  const rest = d.version ? ` · ${d.version}` : '';
  const bad = d.lwt === 'offline';
  const title = d.name ?? d.uniqueId;
  return (
    <article className={clsx('min-w-0 rounded-lg border p-3.5', selected ? 'border-emerald-500/70 bg-emerald-500/10' : bad ? 'border-red-500/40 bg-red-500/5' : d.lwt === 'online' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-line bg-raised/40')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Checkbox checked={selected} onChange={onSelect} label={`Sélectionner ${title}`} />
          <StatusDot tone={lwtTone(d)} />
          {d.equipment ? (
            <Link className="truncate font-medium text-zinc-100 hover:underline" to={`/equipments/${d.equipment.id}`} title={`Équipement ${d.equipment.name}`}>{title}</Link>
          ) : (
            <span className="truncate font-medium text-zinc-100">{title}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={clsx('text-xs', d.lwt === 'online' ? 'text-emerald-300' : bad ? 'text-red-300' : 'text-muted')} title={d.lwtAt ? `depuis ${dateTime(d.lwtAt)}` : undefined}>{lwtLabel(d)}</span>
          <button type="button" onClick={onUntrack} title="Retirer cet appareil (supprime ses équipements)" aria-label={`Retirer ${title}`} className="rounded p-1 text-zinc-500 hover:bg-raised hover:text-red-300">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <p className="mt-1.5 flex min-w-0 items-center gap-x-1 truncate font-mono text-xs text-muted" title={meta}>
        <span className="truncate">{d.uniqueId}</span>
        {d.ip && <> · <CopyIp ip={d.ip} /></>}
        {rest && <span className="shrink-0">{rest}</span>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs text-muted">Suivi des logs</span>
        <LogsCell d={d} canLog={canLog} />
        {d.logs && <LevelCell d={d} levels={levels} defaultLevel={defaultLevel} />}
      </div>
      {d.devices.length > 0 && <SubDevices d={d} />}
      {((!d.hasInfo && !d.infoError) || d.infoError || d.mute) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {!d.hasInfo && !d.infoError && <span title="Le package ne publie pas encore esphome/<unique_id>/info : nom, IP, version et sous-appareils inconnus"><Badge tone="warn">sans info</Badge></span>}
          {d.infoError && <span title={d.infoError}><Badge tone="bad">info invalide</Badge></span>}
          {d.mute && <span title={d.mute}><Badge tone="warn">muet</Badge></span>}
        </div>
      )}
    </article>
  );
}

// The devices that publish their LWT / info on the broker and are not equipments yet, several picked at once: each becomes
// an equipment under its name, or is linked to a manual equipment that looks like it. Its sub-devices are then switched on
// from its card.
function AddDevicesModal({ b, onClose }: { b: EsphomeRoleView; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const offered = b.devices.filter((d) => !d.equipment);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // device -> manual equipment to link it to ('' : a new equipment)
  const [link, setLink] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const list = offered.filter((d) => !q || `${d.name ?? ''} ${d.uniqueId} ${d.ip ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const allPicked = list.length > 0 && list.every((d) => picked.has(d.key));
  const toggle = (key: string, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const add = async () => {
    setBusy(true);
    const targets = offered.filter((d) => picked.has(d.key));
    const results = await Promise.allSettled(
      targets.map((d) => api.createEsphomeEquipments({ key: d.key, devices: [], ...(link[d.key] ? { equipmentId: link[d.key] } : { name: d.name ?? d.uniqueId }) })),
    );
    await Promise.all([qc.invalidateQueries({ queryKey: QUERY }), qc.invalidateQueries({ queryKey: keys.equipments })]);
    const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${targets[i].name ?? targets[i].uniqueId} : ${(r.reason as Error).message}`] : []));
    const ok = targets.length - failed.length;
    if (ok) toast.success(`${ok} appareil${ok > 1 ? 's' : ''} ajouté${ok > 1 ? 's' : ''}`);
    for (const f of failed) toast.error(f);
    setBusy(false);
    if (!failed.length) onClose();
    else setPicked(new Set(targets.filter((_, i) => results[i].status === 'rejected').map((d) => d.key)));
  };
  return (
    <Modal
      open
      wide
      scroll
      onClose={onClose}
      title={`Ajouter des appareils · ${b.brokerName}`}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Annuler</Button>
          <Button variant="primary" icon={Plus} loading={busy} disabled={!picked.size} onClick={() => void add()}>Ajouter {picked.size || ''}</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted">Appareils qui publient un LWT ou un info sur le broker et ne sont pas encore des équipements.</p>
        {!offered.length ? (
          <p className="text-muted">Aucun appareil à ajouter : tout ce que le broker montre est déjà un équipement.</p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Checkbox checked={allPicked} indeterminate={picked.size > 0 && !allPicked} onChange={(v) => setPicked(v ? new Set(list.map((d) => d.key)) : new Set())} label="Tout sélectionner" />
              <input className="input flex-1 py-1" placeholder="Filtrer (nom, id, IP)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filtrer les appareils" />
              <span className="shrink-0 text-xs text-muted">{picked.size} / {offered.length}</span>
            </div>
            <ul className="divide-y divide-line/60 rounded-md border border-line">
              {list.map((d) => (
                <li key={d.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <Checkbox checked={picked.has(d.key)} onChange={(v) => toggle(d.key, v)} label={`Ajouter ${d.name ?? d.uniqueId}`} />
                  <StatusDot tone={lwtTone(d)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-zinc-100">{d.name ?? d.uniqueId}</span>
                    <span className="block truncate font-mono text-xs text-muted">{d.uniqueId}</span>
                  </span>
                  {d.candidates.length > 0 && (
                    <select className="input py-1 text-xs" value={link[d.key] ?? ''} onChange={(e) => setLink((m) => ({ ...m, [d.key]: e.target.value }))} aria-label={`Équipement de ${d.name ?? d.uniqueId}`}>
                      <option value="">Nouvel équipement</option>
                      {d.candidates.map((c) => <option key={c.id} value={c.id}>{`Relier à « ${c.name} »`}</option>)}
                    </select>
                  )}
                  <span className="shrink-0 text-right font-mono text-xs text-muted">{[d.ip, d.version].filter(Boolean).join(' · ') || '—'}</span>
                </li>
              ))}
              {!list.length && <li className="px-3 py-2 text-muted">Aucun résultat.</li>}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

type GroupAction = 'level' | 'logs-on' | 'logs-off' | 'remove';

// Group actions on the devices ticked: the window shows which ones are targeted (the others, which the action cannot
// concern, are left out and named).
function GroupBar({ devices, canLog, levels, onClear }: { devices: EsphomeDevice[]; canLog: boolean; levels: string[]; onClear: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [action, setAction] = useState<GroupAction | null>(null);
  const [level, setLevel] = useState(levels.includes('DEBUG') ? 'DEBUG' : levels[0] ?? '');
  const [busy, setBusy] = useState(false);
  const targets = (a: GroupAction) => {
    switch (a) {
      case 'level': return devices.filter((d) => d.lwt === 'online' && d.level && d.level !== level);
      case 'logs-on': return canLog ? devices.filter((d) => !d.logs) : [];
      case 'logs-off': return devices.filter((d) => d.logs);
      case 'remove': return devices;
    }
  };
  const label: Record<GroupAction, string> = {
    level: `Niveau de log ${level}`,
    'logs-on': 'Activer les logs',
    'logs-off': 'Désactiver les logs',
    remove: 'Retirer',
  };
  const list = action ? targets(action) : [];
  const run = async () => {
    if (!action) return;
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        list.map((d) => {
          switch (action) {
            case 'level': return api.setEsphomeLevel(d.key, level);
            case 'logs-on': return api.setEsphomeLogs(d.key, true);
            case 'logs-off': return api.setEsphomeLogs(d.key, false);
            case 'remove': return removeDevice(d);
          }
        }),
      );
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      await Promise.all([qc.invalidateQueries({ queryKey: QUERY }), ...(action === 'remove' ? [qc.invalidateQueries({ queryKey: keys.equipments })] : [])]);
      const ok = results.length - failed.length;
      if (ok) toast.success(action === 'level' ? `Niveau ${level} demandé à ${ok} appareil${ok > 1 ? 's' : ''}` : `${label[action]} : ${ok} appareil${ok > 1 ? 's' : ''}`);
      if (failed.length) toast.error(`${failed.length} échec${failed.length > 1 ? 's' : ''} : ${(failed[0].reason as Error).message}`);
      setAction(null);
    } finally {
      setBusy(false);
    }
  };
  const skipped = action ? devices.filter((d) => !list.includes(d)) : [];
  const name = (d: EsphomeDevice) => d.name ?? d.uniqueId;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-emerald-500/30 bg-emerald-500/5 px-4 py-2 text-sm">
      <span className="font-medium text-zinc-100">{devices.length} sélectionné{devices.length > 1 ? 's' : ''}</span>
      <Button size="sm" variant="ghost" onClick={onClear}>Tout désélectionner</Button>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <select className="input py-1 text-xs" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Niveau de log à appliquer">
          {levels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <Button size="sm" disabled={!targets('level').length} onClick={() => setAction('level')}>Appliquer le niveau</Button>
        <Button size="sm" disabled={!targets('logs-on').length} onClick={() => setAction('logs-on')}>Activer les logs</Button>
        <Button size="sm" disabled={!targets('logs-off').length} onClick={() => setAction('logs-off')}>Désactiver les logs</Button>
        <Button size="sm" variant="danger" icon={Trash2} onClick={() => setAction('remove')}>Retirer</Button>
      </span>
      <ConfirmModal
        open={!!action}
        onClose={() => setAction(null)}
        onConfirm={() => void run()}
        title={action ? `${label[action]} — ${list.length} appareil${list.length > 1 ? 's' : ''}` : ''}
        confirmLabel={action === 'remove' ? 'Retirer' : 'Appliquer'}
        danger={action === 'remove'}
        loading={busy}
        disabled={!list.length}
      >
        <ul className="max-h-60 space-y-0.5 overflow-y-auto text-sm">
          {list.map((d) => <li key={d.key}><span className="text-zinc-100">{name(d)}</span> <span className="font-mono text-xs text-muted">{d.uniqueId}</span></li>)}
        </ul>
        {action === 'level' && <p className="mt-3 text-xs text-muted">Jusqu'au prochain redémarrage des appareils (la commande n'est pas conservée).</p>}
        {action === 'remove' && <p className="mt-3 text-xs text-muted">Leurs logs sont coupés et leurs équipements supprimés (sondes et historique avec). Ils redeviennent disponibles dans « Ajouter des appareils ».</p>}
        {skipped.length > 0 && <p className="mt-3 text-xs text-muted">Non concernés : {skipped.map(name).join(', ')}.</p>}
      </ConfirmModal>
    </div>
  );
}

function BrokerDevices({ b, canLog, levels, defaultLevel }: { b: EsphomeRoleView; canLog: boolean; levels: string[]; defaultLevel: string }) {
  const { data: sites = [] } = useSites();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const [removing, setRemoving] = useState<EsphomeDevice | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const st = roleStatus({ status: b.status, url: '', carrier: { kind: 'hub', id: '', name: '' } });
  // only the devices that are equipments are listed; the others are offered in « Ajouter des appareils »
  const followed = b.devices.filter((d) => d.equipment);
  const offered = b.devices.length - followed.length;
  const online = followed.filter((d) => d.lwt === 'online').length;
  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await removeDevice(removing);
      toast.success(`${removing.name ?? removing.uniqueId} retiré`);
      setRemoving(null);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      await Promise.all([qc.invalidateQueries({ queryKey: QUERY }), qc.invalidateQueries({ queryKey: keys.equipments })]);
      setRemoveBusy(false);
    }
  };
  const site = sites.find((s) => s.id === b.siteId)?.name ?? b.siteId;
  // devices forgotten since the selection was made drop out of it
  const picked = followed.filter((d) => selected.has(d.key));
  const toggle = (key: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <Panel title={`Appareils de ${b.brokerName}`} icon={Cpu} bodyClassName="" actions={<span className="inline-flex items-center gap-2"><Badge tone={st.tone}>{st.label}</Badge><Button size="sm" variant="primary" icon={Plus} onClick={() => setAdding(true)}>Ajouter des appareils{offered ? ` (${offered})` : ''}</Button></span>}>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3 text-xs text-muted">
        {followed.length > 0 && (
          <Checkbox
            checked={picked.length === followed.length}
            indeterminate={picked.length > 0 && picked.length < followed.length}
            onChange={(v) => setSelected(v ? new Set(followed.map((d) => d.key)) : new Set())}
            label="Tout sélectionner"
          />
        )}
        <p>
          {followed.length} appareil{followed.length > 1 ? 's' : ''} · {online} en ligne · site {site}
        </p>
      </div>
      {picked.length > 0 && <GroupBar devices={picked} canLog={canLog} levels={levels} onClear={() => setSelected(new Set())} />}
      {b.status?.error && <p className="mx-4 my-3 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-200">{b.status.error}</p>}
      {!followed.length ? (
        <p className="p-4 text-sm text-muted">
          {offered ? `Aucun appareil ajouté : ${offered} vu${offered > 1 ? 's' : ''} sur le broker, à ajouter.` : <>Aucun appareil : un ESP apparaît dès qu'il publie son LWT sur <code>esphome/&lt;unique_id&gt;/LWT</code>.</>}
        </p>
      ) : (
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {followed.map((d) => <DeviceCard key={d.key} d={d} canLog={canLog} levels={levels} defaultLevel={defaultLevel} selected={selected.has(d.key)} onSelect={(v) => toggle(d.key, v)} onUntrack={() => setRemoving(d)} />)}
        </div>
      )}
      {adding && <AddDevicesModal b={b} onClose={() => setAdding(false)} />}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()} title="Retirer l'appareil" confirmLabel="Retirer" danger loading={removeBusy}>
        <p>
          Retirer <b>{removing?.name ?? removing?.uniqueId}</b> ? Ses logs sont coupés et son équipement{removing && Object.keys(removing.subEquipments).length ? ` et ceux de ses ${Object.keys(removing.subEquipments).length} sous-appareil(s)` : ''} supprimés,
          avec leurs sondes et leur historique. L'appareil reste visible dans « Ajouter des appareils » tant qu'il publie sur le broker.
        </p>
      </ConfirmModal>
    </Panel>
  );
}

// The inventory of a role (Rôles › ESPHome, « Inventaire » on its card): the devices found on its broker. Its settings
// are edited by its wizard (the pencil of the card, EsphomeWizard).
export function EsphomeInventory({ roleId }: { roleId: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: QUERY, queryFn: api.esphomeSettings });
  if (isLoading) return <div className="flex justify-center p-6"><Spinner /></div>;
  if (error) return <p className="p-4 text-sm text-red-400">{(error as Error).message}</p>;
  const role = data?.roles.find((r) => r.id === roleId);
  if (!data || !role) return <p className="p-4 text-sm text-muted">Rôle ESPHome inconnu : le déclarer dans <Link to="/roles" className="text-emerald-400 hover:underline">Rôles</Link>.</p>;
  return (
    <div>
      <LogsInfo data={data} />
      <BrokerDevices b={role} canLog={!!data.logServer} levels={data.levels} defaultLevel={data.defaultLevel} />
    </div>
  );
}
