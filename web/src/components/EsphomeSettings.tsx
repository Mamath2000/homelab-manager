import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { Cpu, Plus, Radio, Save, SlidersHorizontal } from 'lucide-react';
import { api, type EsphomeBroker, type EsphomeBrokerView, type EsphomeDevice, type EsphomeSettings as Settings } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { keys, useSites } from '../lib/queries';
import { roleStatus } from '../lib/roles';
import { useToast } from '../lib/toast';
import { Badge, Button, Checkbox, ConfirmModal, Modal, Panel, Spinner, StatusDot, Tabs } from './ui';

// Paramètres › ESPHome (homelab#352): the esphome role, carried by the hub. Paramétrage: the brokers listened to (mqtt-broker
// roles), each with the site of its devices; then one tab per broker, its devices as their messages left them
// (esphome/<unique_id>/LWT, info, log_level).

const QUERY = ['settings', 'esphome'] as const;

// what is saved, as the setup edits it: broker -> site set for it ('' : the one of its host)
const savedOf = (data: Settings) => new Map((data.role?.brokers ?? []).map((b) => [b.brokerId, b.siteId ?? '']));

// Paramétrage: which brokers are listened to, and the site of the devices of each (empty: the one of the host of the broker).
// Mounted again when what is saved changes (key), not when the devices do: what is being edited stays.
function BrokersSetup({ data }: { data: Settings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sites = [] } = useSites();
  const [saved] = useState(() => savedOf(data));
  const [chosen, setChosen] = useState(saved);
  // '' : the first log server
  const [server, setServer] = useState(data.role?.logServerSet ?? '');
  const [silent, setSilent] = useState(String(data.role?.silentHours ?? 2));
  const [saving, setSaving] = useState(false);
  const siteName = (id: string | null) => (id ? sites.find((s) => s.id === id)?.name ?? id : null);
  const hours = Number(silent);
  const hoursOk = /^\d+$/.test(silent) && hours >= 0 && hours <= 48;
  const dirty = hours !== data.role?.silentHours || server !== (data.role?.logServerSet ?? '') || chosen.size !== saved.size || [...chosen].some(([id, site]) => saved.get(id) !== site);
  const toggle = (id: string, on: boolean) =>
    setChosen((m) => {
      const next = new Map(m);
      if (on) next.set(id, '');
      else next.delete(id);
      return next;
    });
  const setSite = (id: string, site: string) => setChosen((m) => new Map(m).set(id, site));
  const save = async () => {
    setSaving(true);
    try {
      // in the order of the brokers of the hub, as they are listed
      const brokers: EsphomeBroker[] = data.brokers.filter((b) => chosen.has(b.id)).map((b) => ({ brokerId: b.id, ...(chosen.get(b.id) ? { siteId: chosen.get(b.id) } : {}) }));
      await api.saveEsphome(brokers, server, hours);
      await Promise.all([qc.invalidateQueries({ queryKey: QUERY }), qc.invalidateQueries({ queryKey: keys.roles })]);
      toast.success('Paramétrage ESPHome enregistré');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title="Brokers écoutés" icon={SlidersHorizontal} bodyClassName="">
      <p className="border-b border-line px-4 py-3 text-xs text-muted">
        Le hub s'abonne à <code>esphome/+/LWT</code>, <code>esphome/+/info</code> et <code>esphome/+/log_level</code> sur chaque broker coché. Un appareil
        découvert prend le site de son broker : celui de l'hôte du broker, sauf si un autre site est choisi ici (broker d'un site hébergé sur un autre). Un
        broker se déclare dans <Link to="/settings?tab=roles" className="text-emerald-400 hover:underline">Paramètres › Rôles</Link> ; retiré d'ici, ses
        appareils sont oubliés.
      </p>
      {!data.brokers.length ? (
        <p className="p-4 text-sm text-muted">Aucun rôle Broker MQTT déclaré.</p>
      ) : (
        <ul>
          {data.brokers.map((b) => {
            const on = chosen.has(b.id);
            return (
              <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-sm first:border-t-0">
                <Checkbox checked={on} onChange={(v) => toggle(b.id, v)} label={`Écouter ${b.name}`} />
                <span className="font-medium text-zinc-100">{b.name}</span>
                <span className="font-mono text-xs text-muted">{b.id}</span>
                <label className="ml-auto flex items-center gap-2 text-xs text-muted">
                  Site des appareils
                  <select className="input py-1" disabled={!on} value={chosen.get(b.id) ?? ''} onChange={(e) => setSite(b.id, e.target.value)}>
                    <option value="">{siteName(b.siteId) ? `site de l'hôte (${siteName(b.siteId)})` : "site de l'hôte (aucun)"}</option>
                    {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="space-y-2 border-t border-line px-4 py-3 text-sm">
        <label className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-zinc-100">Serveur de logs</span>
          {data.logServers.length ? (
            <select className="input py-1" value={server} onChange={(e) => setServer(e.target.value)}>
              <option value="">{`le premier (${data.logServers[0].name})`}</option>
              {data.logServers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          ) : (
            <span className="text-xs text-amber-300">aucun : les logs des appareils ne peuvent pas être activés (déclarer un rôle Serveur de logs)</span>
          )}
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-zinc-100">Muet après</span>
          <input className="input w-20 py-1" inputMode="numeric" value={silent} onChange={(e) => setSilent(e.target.value)} aria-label="Heures sans ligne avant muet" />
          <span className="text-xs text-muted">h sans ligne pour un ESP en ligne aux logs activés (0 : pas de surveillance ; le package envoie un heartbeat toutes les heures)</span>
        </label>
        <p className="text-xs text-muted">
          Les lignes des appareils dont les logs sont activés (onglet du broker) y sont écrites par le hub (<code>source=esphome</code>, champ <code>device</code>
          pour un sous-appareil).
          {data.role?.shipping && (
            <> Écrites depuis le démarrage du hub : {data.role.shipping.sent}, en attente : {data.role.shipping.waiting}, perdues : {data.role.shipping.dropped}.</>
          )}
        </p>
        {data.role?.shipping?.error && <p className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-200">Écriture en échec : {data.role.shipping.error}</p>}
      </div>
      <div className="flex justify-end border-t border-line px-4 py-3">
        <Button variant="primary" icon={Save} loading={saving} disabled={!dirty || !hoursOk} onClick={save}>Enregistrer</Button>
      </div>
    </Panel>
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
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="inline-flex items-center gap-2" title={why ?? (d.logs ? 'Ne plus envoyer ses lignes au serveur de logs' : 'Envoyer ses lignes au serveur de logs')}>
        {busy ? <Spinner className="h-4 w-4" /> : <Checkbox checked={d.logs} onChange={(v) => void (why && v ? null : toggle(v))} label={`Logs de ${d.name ?? d.uniqueId}`} />}
        <span className="text-xs text-muted">{d.logs ? 'activés' : why ?? 'désactivés'}</span>
      </span>
      {d.logs && (
        <span className="text-xs text-muted">
          {d.lastLineAt ? <>dernière ligne {timeAgo(d.lastLineAt)}</> : 'aucune ligne reçue'}
          {d.equipment && d.name && (
            <> · <Link className="underline" to={`/logs?hostname=${encodeURIComponent(d.name)}&source=esphome`}>voir</Link></>
          )}
        </span>
      )}
    </div>
  );
}

// the sub-devices that are not equipments yet
const missingSubs = (d: EsphomeDevice) => d.devices.filter((x) => !d.subEquipments[x.id]);

// Makes the equipments of an ESP: the ESP (made under a name, or a manual equipment linked) and the sub-devices chosen, all
// checked at first. On an ESP already made: the sub-devices it lacks. A window: several equipments at once, the window shows
// which (and with which probes) before.
function CreateModal({ d, site, onClose }: { d: EsphomeDevice; site: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const subs = missingSubs(d);
  const [name, setName] = useState(d.name ?? d.uniqueId);
  // '' : made under its name, else the manual equipment linked
  const [linkTo, setLinkTo] = useState('');
  const [chosen, setChosen] = useState(() => new Set(subs.map((x) => x.id)));
  const [busy, setBusy] = useState(false);
  const toggle = (id: string, on: boolean) =>
    setChosen((c) => {
      const next = new Set(c);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createEsphomeEquipments({ key: d.key, devices: [...chosen], ...(d.equipment ? {} : linkTo ? { equipmentId: linkTo } : { name: name.trim() }) });
      await Promise.all([qc.invalidateQueries({ queryKey: QUERY }), qc.invalidateQueries({ queryKey: keys.equipments })]);
      toast.success(`${r.created} équipement${r.created > 1 ? 's' : ''} créé${r.created > 1 ? 's' : ''}${r.linked ? ', équipement manuel relié' : ''}`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const nothing = !!d.equipment && !chosen.size;
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={d.equipment ? `Sous-appareils de ${d.equipment.name}` : `Équipements de ${d.name ?? d.uniqueId}`}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Annuler</Button>
          <Button variant="primary" icon={Plus} loading={busy} disabled={nothing || (!d.equipment && !linkTo && !name.trim())} onClick={create}>Créer</Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-xs text-muted">Site : {site ?? 'aucun'} (celui du broker). Type : module domotique.</p>
        {!d.equipment && (
          <section className="space-y-2">
            <h4 className="font-medium text-zinc-100">L'ESP</h4>
            <label className="flex items-center gap-2">
              <input type="radio" name="esp" checked={!linkTo} onChange={() => setLinkTo('')} />
              <span>Créer sous le nom</span>
              <input className="input py-1" maxLength={64} value={name} disabled={!!linkTo} onChange={(e) => setName(e.target.value)} aria-label="Nom de l'équipement" />
            </label>
            {d.candidates.map((c) => (
              <label key={c.id} className="flex items-center gap-2">
                <input type="radio" name="esp" checked={linkTo === c.id} onChange={() => setLinkTo(c.id)} />
                <span>Relier à l'équipement manuel « {c.name} »{c.ip && <span className="ml-1 font-mono text-xs text-muted">{c.ip}</span>}</span>
              </label>
            ))}
            <p className="text-xs text-muted">
              Sondes : ping{d.ip ? <> sur <span className="font-mono">{d.ip}</span></> : ' (dès que son IP est connue)'} et LWT (<code>esphome/{d.uniqueId}/LWT</code> = online). Le
              site et l'IP suivent ensuite l'appareil.
            </p>
          </section>
        )}
        {subs.length > 0 && (
          <section className="space-y-2">
            <h4 className="font-medium text-zinc-100">Sous-appareils</h4>
            <p className="text-xs text-muted">Chacun devient un équipement placé sous l'ESP, avec sa propre sonde sur le LWT de l'ESP. Décocher ceux qui ne sont que l'ESP lui-même.</p>
            <ul className="space-y-1">
              {subs.map((x) => (
                <li key={x.id} className="flex items-center gap-2">
                  <Checkbox checked={chosen.has(x.id)} onChange={(v) => toggle(x.id, v)} label={`Créer ${x.name ?? x.id}`} />
                  <span className="text-zinc-100">{x.name ?? x.id}</span>
                  <span className="font-mono text-xs text-muted">{x.id}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}

// The equipment of a device, or what makes it: at once for an ESP alone (no sub-device, no manual equipment to link),
// through the window otherwise.
function EquipmentCell({ d, site }: { d: EsphomeDevice; site: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const subs = missingSubs(d);
  const direct = async () => {
    setBusy(true);
    try {
      await api.createEsphomeEquipments({ key: d.key, devices: [] });
      await Promise.all([qc.invalidateQueries({ queryKey: QUERY }), qc.invalidateQueries({ queryKey: keys.equipments })]);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const made = Object.values(d.subEquipments);
  return (
    <div className="flex flex-col items-start gap-1">
      {d.equipment ? (
        <>
          <Link className="underline" to={`/equipments/${d.equipment.id}`}>{d.equipment.name}</Link>
          {made.length > 0 && <span className="text-xs text-muted">+ {made.length} sous-appareil{made.length > 1 ? 's' : ''}</span>}
          {subs.length > 0 && <Button size="sm" icon={Plus} onClick={() => setOpen(true)}>Sous-appareils ({subs.length})</Button>}
        </>
      ) : (
        <Button size="sm" variant="primary" loading={busy} onClick={() => (subs.length || d.candidates.length ? setOpen(true) : void direct())}>Créer l'équipement</Button>
      )}
      {open && <CreateModal d={d} site={site} onClose={() => setOpen(false)} />}
    </div>
  );
}

const lwtTone = (d: EsphomeDevice) => (d.lwt === 'online' ? 'ok' : d.lwt === 'offline' ? 'bad' : 'neutral');
const lwtLabel = (d: EsphomeDevice) => (d.lwt === 'online' ? 'en ligne' : d.lwt === 'offline' ? 'hors ligne' : 'LWT absent');

// one labelled line of a card
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

// a device as a small block: identity and state on top, then its fields, then what can be done with it
function DeviceCard({ d, site, canLog, levels, defaultLevel, selected, onSelect }: { d: EsphomeDevice; site: string | null; canLog: boolean; levels: string[]; defaultLevel: string; selected: boolean; onSelect: (v: boolean) => void }) {
  const subs = d.devices.map((x) => x.name ?? x.id).join(', ');
  return (
    <li className={clsx('flex flex-col rounded-lg border bg-raised/40', selected ? 'border-emerald-500/60' : 'border-line')}>
      <div className="flex items-start gap-2 border-b border-line px-3 py-2">
        <Checkbox checked={selected} onChange={onSelect} label={`Sélectionner ${d.name ?? d.uniqueId}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100" title={d.name ?? d.uniqueId}>{d.name ?? d.uniqueId}</div>
          <div className="truncate font-mono text-xs text-muted" title={d.uniqueId}>{d.uniqueId}</div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5" title={`${lwtLabel(d)}${d.lwtAt ? ` depuis ${dateTime(d.lwtAt)}` : ''}`}>
          <StatusDot tone={lwtTone(d)} />
          <span className="text-xs text-muted">{lwtLabel(d)}</span>
        </span>
      </div>
      <div className="flex-1 divide-y divide-line/50 px-3 py-1">
        <Field label="IP"><span className="font-mono">{d.ip ?? '—'}</span></Field>
        <Field label="Version">{d.version ?? '—'}</Field>
        <Field label="Sous-appareils"><span title={subs || undefined}>{d.devices.length ? `${d.devices.length} : ${subs}` : '—'}</span></Field>
        <Field label="Vu"><span className="text-muted" title={dateTime(d.lastSeenAt)}>{timeAgo(d.lastSeenAt)}</span></Field>
        <Field label="Niveau de log"><LevelCell d={d} levels={levels} defaultLevel={defaultLevel} /></Field>
        <Field label="Logs"><LogsCell d={d} canLog={canLog} /></Field>
        <Field label="Équipement"><EquipmentCell d={d} site={site} /></Field>
      </div>
      {(!d.hasInfo && !d.infoError) || d.infoError || d.mute ? (
        <div className="flex flex-wrap gap-1 border-t border-line px-3 py-2">
          {!d.hasInfo && !d.infoError && <span title="Le package ne publie pas encore esphome/<unique_id>/info : nom, IP, version et sous-appareils inconnus"><Badge tone="warn">sans info</Badge></span>}
          {d.infoError && <span title={d.infoError}><Badge tone="bad">info invalide</Badge></span>}
          {d.mute && <span title={d.mute}><Badge tone="warn">muet</Badge></span>}
        </div>
      ) : null}
    </li>
  );
}

type GroupAction = 'level' | 'logs-on' | 'logs-off' | 'equipments';

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
      case 'logs-on': return canLog ? devices.filter((d) => d.equipment && !d.logs) : [];
      case 'logs-off': return devices.filter((d) => d.logs);
      // an ESP alone: nothing to choose in the single window (no sub-device, no manual equipment to link)
      case 'equipments': return devices.filter((d) => !d.equipment && !missingSubs(d).length && !d.candidates.length);
    }
  };
  const label: Record<GroupAction, string> = {
    level: `Niveau de log ${level}`,
    'logs-on': 'Activer les logs',
    'logs-off': 'Désactiver les logs',
    equipments: 'Créer les équipements',
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
            case 'equipments': return api.createEsphomeEquipments({ key: d.key, devices: [] });
          }
        }),
      );
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      await Promise.all([qc.invalidateQueries({ queryKey: QUERY }), ...(action === 'equipments' ? [qc.invalidateQueries({ queryKey: keys.equipments })] : [])]);
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
        <Button size="sm" icon={Plus} disabled={!targets('equipments').length} onClick={() => setAction('equipments')}>Créer les équipements</Button>
      </span>
      <ConfirmModal
        open={!!action}
        onClose={() => setAction(null)}
        onConfirm={() => void run()}
        title={action ? `${label[action]} — ${list.length} appareil${list.length > 1 ? 's' : ''}` : ''}
        confirmLabel="Appliquer"
        loading={busy}
        disabled={!list.length}
      >
        <ul className="max-h-60 space-y-0.5 overflow-y-auto text-sm">
          {list.map((d) => <li key={d.key}><span className="text-zinc-100">{name(d)}</span> <span className="font-mono text-xs text-muted">{d.uniqueId}</span></li>)}
        </ul>
        {action === 'level' && <p className="mt-3 text-xs text-muted">Jusqu'au prochain redémarrage des appareils (la commande n'est pas conservée).</p>}
        {action === 'equipments' && <p className="mt-3 text-xs text-muted">Seuls les ESP sans sous-appareil à créer ni équipement manuel à relier sont concernés ; les autres se font un par un.</p>}
        {skipped.length > 0 && <p className="mt-3 text-xs text-muted">Non concernés : {skipped.map(name).join(', ')}.</p>}
      </ConfirmModal>
    </div>
  );
}

function BrokerDevices({ b, canLog, levels, defaultLevel }: { b: EsphomeBrokerView; canLog: boolean; levels: string[]; defaultLevel: string }) {
  const { data: sites = [] } = useSites();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const st = roleStatus({ status: b.status, url: '', carrier: { kind: 'hub', id: '', name: '' } });
  const online = b.devices.filter((d) => d.lwt === 'online').length;
  const site = b.site ? sites.find((s) => s.id === b.site)?.name ?? b.site : null;
  // devices forgotten since the selection was made drop out of it
  const picked = b.devices.filter((d) => selected.has(d.key));
  const toggle = (key: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <Panel title={`Appareils de ${b.name}`} icon={Cpu} bodyClassName="" actions={<Badge tone={st.tone}>{st.label}</Badge>}>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3 text-xs text-muted">
        {b.devices.length > 0 && (
          <Checkbox
            checked={picked.length === b.devices.length}
            indeterminate={picked.length > 0 && picked.length < b.devices.length}
            onChange={(v) => setSelected(v ? new Set(b.devices.map((d) => d.key)) : new Set())}
            label="Tout sélectionner"
          />
        )}
        <p>
          {b.devices.length} appareil{b.devices.length > 1 ? 's' : ''} · {online} en ligne · site {site ?? 'aucun'}
          {b.siteId ? ' (choisi pour ce broker)' : " (celui de l'hôte du broker)"}
        </p>
      </div>
      {picked.length > 0 && <GroupBar devices={picked} canLog={canLog} levels={levels} onClear={() => setSelected(new Set())} />}
      {b.status?.error && <p className="mx-4 my-3 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-200">{b.status.error}</p>}
      {!b.devices.length ? (
        <p className="p-4 text-sm text-muted">Aucun appareil : un ESP apparaît dès qu'il publie son LWT sur <code>esphome/&lt;unique_id&gt;/LWT</code>.</p>
      ) : (
        <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
          {b.devices.map((d) => <DeviceCard key={d.key} d={d} site={site} canLog={canLog} levels={levels} defaultLevel={defaultLevel} selected={selected.has(d.key)} onSelect={(v) => toggle(d.key, v)} />)}
        </ul>
      )}
    </Panel>
  );
}

export function EsphomeSettings() {
  const { data, isLoading, error } = useQuery({ queryKey: QUERY, queryFn: api.esphomeSettings });
  // sub-tab kept in the URL (?sub=…): coming back from another screen restores it
  const [params, setParams] = useSearchParams();
  const tab = params.get('sub') ?? 'setup';
  const setTab = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === 'setup') next.delete('sub');
    else next.set('sub', id);
    setParams(next, { replace: true });
  };
  if (isLoading) return <div className="flex justify-center p-6"><Spinner /></div>;
  if (error) return <p className="p-4 text-sm text-red-400">{(error as Error).message}</p>;
  if (!data?.role) return <p className="p-4 text-sm text-muted">Rôle ESPHome non déclaré : le déclarer dans <Link to="/settings?tab=roles" className="text-emerald-400 hover:underline">Paramètres › Rôles</Link>.</p>;
  const brokers = data.role.brokers;
  const tabs = [{ id: 'setup', label: 'Paramétrage', icon: SlidersHorizontal }, ...brokers.map((b) => ({ id: b.brokerId, label: `${b.name} (${b.devices.length})`, icon: Radio }))];
  const current = tabs.some((t) => t.id === tab) ? tab : 'setup';
  const broker = brokers.find((b) => b.brokerId === current);
  return (
    <div>
      <Tabs tabs={tabs} value={current} onChange={setTab} />
      {broker ? <BrokerDevices b={broker} canLog={!!data.role.logServer} levels={data.levels} defaultLevel={data.defaultLevel} /> : <BrokersSetup key={JSON.stringify([[...savedOf(data)], data.role.logServerSet, data.role.silentHours])} data={data} />}
    </div>
  );
}
