import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertTriangle, ArrowRight, MapPin, RefreshCw, Waypoints } from 'lucide-react';
import { api, type OmadaController, type OmadaDeviceView, type OmadaSiteView, type OmadaVpnView } from '../lib/api';
import { TYPE_LABELS } from '../lib/equipment';
import { dateTime, timeAgo } from '../lib/format';
import { useSites } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, Panel, Spinner, StatusDot } from './ui';
import { VpnProbeModal } from './VpnProbeModal';

// Paramètres › Omada: the devices of each controller (omada-controller role), site by site. An Omada site is matched to a
// site of the homelab; a device is an equipment of the hub once created from it, or linked to a manual equipment (a hub
// equipment has no MAC: the ones proposed share its address or its name). Presence and checks then come from the controller.

function DeviceRow({ controller, d }: { controller: string; d: OmadaDeviceView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // the name of the equipment: typed before it is created, saved when edited (Enter or leaving the field)
  const [name, setName] = useState(d.equipment?.name ?? d.name);
  const rename = async () => {
    const next = name.trim();
    if (!d.equipment || next === d.equipment.name) return setName(d.equipment?.name ?? name);
    if (!next) return setName(d.equipment.name);
    try {
      await api.updateEquipment(d.equipment.id, { name: next });
      qc.invalidateQueries({ queryKey: ['settings', 'omada'] });
      qc.invalidateQueries({ queryKey: ['equipments'] });
    } catch (err) {
      toast.error((err as Error).message);
      setName(d.equipment.name);
    }
  };
  const link = async (equipmentId?: string) => {
    setBusy(equipmentId ?? 'new');
    try {
      await api.linkOmadaDevice(controller, d.mac, { ...(equipmentId ? { equipmentId } : { name }) });
      qc.invalidateQueries({ queryKey: ['settings', 'omada'] });
      qc.invalidateQueries({ queryKey: ['equipments'] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-sm">
      <span className={d.connected ? 'text-emerald-400' : 'text-red-400'} title={d.connected ? 'connecté' : 'déconnecté'}>●</span>
      <span className="min-w-32 text-zinc-100" title={d.equipment ? `Nom dans Omada : ${d.name}` : 'Nom de l\'équipement à créer'}>
        <input
          className="input py-1"
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={d.equipment ? rename : undefined}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label={`Nom de l'équipement ${d.name}`}
        />
      </span>
      <Badge tone="neutral">{TYPE_LABELS[d.type]}</Badge>
      <span className="text-xs text-muted">{d.model}{d.ip && <> · <span className="font-mono">{d.ip}</span></>}{d.firmware && ` · ${d.firmware.split(' ')[0]}`}</span>
      <span className="ml-auto inline-flex flex-wrap items-center gap-1.5">
        {d.equipment ? (
          <Link className="underline" to={`/equipments/${d.equipment.id}`}>Voir l'équipement</Link>
        ) : (
          <>
            <Badge tone="neutral">non géré</Badge>
            {d.candidates.map((c) => (
              <Button key={c.id} size="sm" loading={busy === c.id} disabled={!!busy} onClick={() => link(c.id)} title={c.ip ?? undefined}>Relier à « {c.name} »</Button>
            ))}
            <Button size="sm" variant="primary" loading={busy === 'new'} disabled={!!busy} onClick={() => link()}>Créer l'équipement</Button>
          </>
        )}
      </span>
    </li>
  );
}

// What a VPN still needs from the admin, shown as a warning in front of it ('' : nothing)
function vpnTodo(v: OmadaVpnView) {
  if (!v.gateway) return 'Aucune passerelle Omada sur ce site';
  if (!v.gateway.equipment) return `Intervention manuelle requise : créer ou relier l'équipement de la passerelle ${v.gateway.name} (site ${v.siteName} ci-dessous)`;
  if (!v.probe) return 'Sonde créée au prochain relevé';
  if (!v.probe.configured) return 'Intervention manuelle requise : choisir la source et la cible de la sonde';
  return '';
}

const subnetList = (l: string[]) => (l.length ? l.join(', ') : '—');

const probeTone = { up: 'ok', down: 'bad', unknown: 'neutral' } as const;

function VpnRow({ v }: { v: OmadaVpnView }) {
  const todo = vpnTodo(v);
  const [editing, setEditing] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-sm first:border-t-0">
      <span title={!v.enabled ? 'désactivé dans Omada' : v.established ? 'tunnel établi (associations de sécurité en entrée et en sortie)' : 'tunnel non établi'}>
        <StatusDot tone={!v.enabled ? 'neutral' : v.established ? 'ok' : 'bad'} />
      </span>
      <span className="font-medium text-zinc-100">{v.name}</span>
      {!v.enabled && <Badge tone="neutral">désactivé</Badge>}
      <span className="text-xs text-muted">
        {v.siteName}
        {v.gateway && <> · {v.gateway.equipment ? <Link className="underline" to={`/equipments/${v.gateway.equipment.id}`}>{v.gateway.equipment.name}</Link> : v.gateway.name}</>}
      </span>
      <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-xs text-zinc-400">
        {subnetList(v.localSubnets)}
        <ArrowRight className="h-3.5 w-3.5 text-muted" aria-label="vers" />
        {subnetList(v.remoteSubnets)}
      </span>
      <span className="ml-auto inline-flex items-center gap-2">
        {todo && (
          <span className="text-amber-400" title={todo} aria-label={todo}>
            <AlertTriangle className="h-4 w-4" />
          </span>
        )}
        {v.probe && (
          <>
            <span title={v.probe.message ?? undefined}><Badge tone={probeTone[v.probe.state]}>sonde {v.probe.state === 'unknown' ? 'inconnue' : v.probe.state}</Badge></span>
            <Button size="sm" variant={v.probe.configured ? 'secondary' : 'primary'} onClick={() => setEditing(true)}>{v.probe.configured ? 'Modifier' : 'Configurer'}</Button>
          </>
        )}
      </span>
      {editing && v.probe && <VpnProbeModal probeId={v.probe.id} onClose={() => setEditing(false)} />}
    </li>
  );
}

// The site-to-site VPNs of every controller, before the devices: each one is carried by the gateway of its site.
function VpnPanel({ controllers }: { controllers: OmadaController[] }) {
  const vpns = controllers.flatMap((c) => c.vpns);
  const errors = controllers.filter((c) => c.vpnError);
  if (!vpns.length && !errors.length) return null;
  return (
    <Panel title="VPN site à site" icon={Waypoints} bodyClassName="">
      {errors.map((c) => (
        <p key={c.id} className="mx-4 my-3 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-200">Lecture des VPN de {c.name} en échec : {c.vpnError}</p>
      ))}
      <ul>{vpns.map((v) => <VpnRow key={`${v.siteId}-${v.id}`} v={v} />)}</ul>
    </Panel>
  );
}

function SiteBlock({ controller, site }: { controller: string; site: OmadaSiteView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sites } = useSites();
  const change = async (homelabSiteId: string) => {
    try {
      await api.setOmadaSite(controller, site.id, homelabSiteId);
      qc.invalidateQueries({ queryKey: ['settings', 'omada'] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const managed = site.devices.filter((d) => d.equipment).length;
  return (
    <section className="border-t border-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface-2/40 px-4 py-2">
        <MapPin className="h-4 w-4 text-muted" />
        <h3 className="font-medium text-zinc-100">{site.name}</h3>
        <span className="text-xs text-muted">{site.devices.length} appareil{site.devices.length > 1 ? 's' : ''} · {managed} suivi{managed > 1 ? 's' : ''}</span>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          Site du homelab
          <select className="input py-1" value={site.homelabSiteId ?? ''} onChange={(e) => change(e.target.value)}>
            <option value="">— aucun —</option>
            {sites?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      </div>
      {!site.homelabSiteId && <p className="px-4 py-2 text-xs text-amber-300">Sans site du homelab, les équipements créés n'ont pas de site.</p>}
      <ul>{site.devices.map((d) => <DeviceRow key={d.mac} controller={controller} d={d} />)}</ul>
    </section>
  );
}

function ControllerPanel({ c }: { c: OmadaController }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [polling, setPolling] = useState(false);
  const poll = async () => {
    setPolling(true);
    try {
      await api.pollOmada();
      qc.invalidateQueries({ queryKey: ['settings', 'omada'] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPolling(false);
    }
  };
  return (
    <Panel
      title={`Contrôleur ${c.name}`}
      icon={MapPin}
      bodyClassName=""
      actions={<Button size="sm" icon={RefreshCw} loading={polling} onClick={poll}>Relever</Button>}
    >
      <p className="px-4 py-3 text-xs text-muted" title={c.polledAt ? dateTime(c.polledAt) : undefined}>{c.polledAt ? `relevé ${timeAgo(c.polledAt)}` : 'jamais relevé'}</p>
      {c.pollError && <p className="mx-4 mb-3 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-200">Dernier relevé en échec : {c.pollError}</p>}
      {c.sites.map((s) => <SiteBlock key={s.id} controller={c.id} site={s} />)}
    </Panel>
  );
}

export function OmadaInventory() {
  const { data, isLoading, error } = useQuery({ queryKey: ['settings', 'omada'], queryFn: api.omadaInventory });
  if (isLoading) return <div className="flex justify-center p-6"><Spinner /></div>;
  if (error) return <p className="p-4 text-sm text-red-400">{(error as Error).message}</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Appareils relus toutes les 5 minutes, site par site. Associez chaque site Omada à un site du homelab, puis créez l'équipement d'un appareil ou reliez-le à un
        équipement manuel existant (proposé s'il a la même adresse IP ou le même nom) : sa présence vient alors du contrôleur. Le contrôleur se déclare dans{' '}
        <Link to="/settings?tab=roles" className="text-emerald-400 hover:underline">Paramètres › Rôles</Link>.
      </p>
      {data && <VpnPanel controllers={data.controllers} />}
      {data?.controllers.map((c) => <ControllerPanel key={c.id} c={c} />)}
    </div>
  );
}
