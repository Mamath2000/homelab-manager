import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertTriangle, ArrowRight, MapPin, RefreshCw, Trash2, Waypoints } from 'lucide-react';
import { api, type OmadaController, type OmadaDeviceView, type OmadaSiteView, type OmadaVpnView } from '../lib/api';
import { TYPE_LABELS } from '../lib/equipment';
import { dateTime, timeAgo } from '../lib/format';
import { useSites } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, ConfirmModal, Panel, Spinner, StatusDot } from './ui';
import { VpnProbeModal } from './VpnProbeModal';

// Rôles › Omada: the devices of each controller (omada-controller role), site by site. An Omada site is matched to a
// site of the homelab; a device is an equipment of the hub once created from it, or linked to a manual equipment (a hub
// equipment has no MAC: the ones proposed share its address or its name). Presence and checks then come from the controller.

// tunnels: the VPNs this device carries as a gateway (their probes go with its equipment)
function DeviceRow({ controller, d, tunnels }: { controller: string; d: OmadaDeviceView; tunnels: OmadaVpnView[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
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
  // deletes the equipment (its probes with it): the device comes back as « non géré », to create again if wanted
  const remove = async () => {
    if (!d.equipment) return;
    setBusy('remove');
    try {
      await api.deleteEquipment(d.equipment.id);
      qc.invalidateQueries({ queryKey: ['settings', 'omada'] });
      qc.invalidateQueries({ queryKey: ['equipments'] });
      setRemoving(false);
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
          <>
            <Link className="underline" to={`/equipments/${d.equipment.id}`}>Voir l'équipement</Link>
            <Button size="sm" variant="danger" icon={Trash2} aria-label={`Supprimer l'équipement ${d.equipment.name}`} title="Supprimer l'équipement" disabled={!!busy} onClick={() => setRemoving(true)} />
          </>
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
      {d.equipment && (
        <ConfirmModal open={removing} onClose={() => busy !== 'remove' && setRemoving(false)} onConfirm={() => void remove()} title="Supprimer l'équipement" confirmLabel="Supprimer" danger loading={busy === 'remove'}>
          <p>L'équipement « {d.equipment.name} » et ses sondes sont supprimés. L'appareil reste dans l'inventaire Omada, non géré : il peut être recréé.</p>
          {tunnels.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-amber-200">
              <p className="font-medium">Cette passerelle porte {tunnels.length > 1 ? `${tunnels.length} tunnels VPN` : 'un tunnel VPN'} :</p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {tunnels.map((v) => (
                  <li key={v.id}>
                    {v.name}
                    {v.probe ? (v.probe.configured ? ' : sonde supprimée, sa source et sa cible sont perdues' : ' : sonde supprimée (pas encore configurée)') : ''}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs">Sans l'équipement de la passerelle, les tunnels ne sont plus surveillés ; recréer l'équipement refait les sondes, à configurer de nouveau.</p>
            </div>
          )}
        </ConfirmModal>
      )}
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

function SiteBlock({ controller, site, vpns }: { controller: string; site: OmadaSiteView; vpns: OmadaVpnView[] }) {
  const { data: sites } = useSites();
  const managed = site.devices.filter((d) => d.equipment).length;
  const homelab = sites?.find((s) => s.id === site.homelabSiteId)?.name;
  return (
    <section className="border-t border-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface-2/40 px-4 py-2">
        <MapPin className="h-4 w-4 text-muted" />
        <h3 className="font-medium text-zinc-100">{site.name}</h3>
        <span className="text-xs text-muted">{site.devices.length} appareil{site.devices.length > 1 ? 's' : ''} · {managed} suivi{managed > 1 ? 's' : ''}</span>
        <span className="ml-auto text-xs text-muted">Site du homelab : {homelab ?? 'inconnu'}</span>
      </div>
      <ul>{site.devices.map((d) => <DeviceRow key={d.mac} controller={controller} d={d} tunnels={vpns.filter((v) => v.gateway?.mac === d.mac)} />)}</ul>
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
      {c.sites.map((s) => <SiteBlock key={s.id} controller={c.id} site={s} vpns={c.vpns} />)}
    </Panel>
  );
}

// controllerId: only that controller (the role the window is opened from), else all of them
export function OmadaInventory({ controllerId }: { controllerId?: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['settings', 'omada'], queryFn: api.omadaInventory });
  if (isLoading) return <div className="flex justify-center p-6"><Spinner /></div>;
  if (error) return <p className="p-4 text-sm text-red-400">{(error as Error).message}</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Appareils relus toutes les 5 minutes : un rôle lit un site du contrôleur, rattaché à un site du homelab. Créez l'équipement d'un appareil ou reliez-le à un
        équipement manuel existant (proposé s'il a la même adresse IP ou le même nom) : sa présence vient alors du contrôleur. Le contrôleur se déclare dans{' '}
        <Link to="/roles" className="text-emerald-400 hover:underline">Rôles</Link>.
      </p>
      {data && <VpnPanel controllers={data.controllers.filter((c) => !controllerId || c.id === controllerId)} />}
      {data?.controllers.filter((c) => !controllerId || c.id === controllerId).map((c) => <ControllerPanel key={c.id} c={c} />)}
    </div>
  );
}
