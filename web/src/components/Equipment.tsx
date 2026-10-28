import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Save } from 'lucide-react';
import { api, type Equipment, type EquipmentType, type StatusView } from '../lib/api';
import { EQUIPMENT_TYPES, SOURCE_LABELS, TYPE_LABELS, probeCls, probeText, useSiteName } from '../lib/equipment';
import { cellCls } from '../lib/monitoring';
import { keys, useEquipments } from '../lib/queries';
import { useToast } from '../lib/toast';
import { SiteSelect } from './HostTags';
import { field } from './ProxmoxServer';
import { Button, ConfirmModal, Modal } from './ui';

// Equipment (hub/src/equipments.ts): the squares of its probes and the form of a manual one.

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+:[0-9a-fA-F:.]*$/;

// One square per probe (up, down, unknown); an outlined square when it has none. The connection reported by an
// automatic source comes first.
export function ProbeSquares({ equipment, status }: { equipment: Equipment; status: StatusView | undefined }) {
  const sq = 'h-3.5 w-3.5';
  const native = status?.equipments[equipment.id]?.domains.system;
  if (!equipment.probes.length && !native) return <span className={clsx('block rounded-[3px] ring-1 ring-inset ring-zinc-600', sq)} title="aucune sonde" />;
  return (
    <span className="flex flex-wrap gap-[3px]">
      {native && <span className={clsx('block rounded-[3px] ring-1 ring-inset ring-zinc-950/40', sq, cellCls[native.level])} title={`Connexion (${SOURCE_LABELS[equipment.source]})`} />}
      {equipment.probes.map((p) => <span key={p.id} className={clsx('block rounded-[3px]', sq, probeCls[p.state])} title={probeText(p)} />)}
    </span>
  );
}

interface Form {
  name: string;
  type: EquipmentType;
  siteId: string;
  ip: string;
  uplinkId: string;
  ping: boolean;
}

const formOf = (e: Equipment | null): Form => ({
  name: e?.name ?? '',
  type: e?.type ?? 'other',
  siteId: e?.siteId ?? '',
  ip: e?.ip ?? '',
  uplinkId: e?.uplinkId ?? '',
  ping: true,
});

// Creation and edition of an equipment. An equipment of an automatic source only gets its name changed here: the
// rest comes from the source.
export function EquipmentModal({ equipment, onClose }: { equipment: Equipment | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: all } = useEquipments();
  const siteName = useSiteName();
  const [initial] = useState(() => formOf(equipment));
  const [form, setForm] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const synced = !!equipment && equipment.source !== 'manual';
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const ip = form.ip.trim();
  const nameOk = form.name.trim().length > 0 && form.name.trim().length <= 64;
  const ipOk = !ip || IP_RE.test(ip);
  // what can be upstream: the others, the site of the equipment first
  const uplinks = (all ?? []).filter((e) => e.id !== equipment?.id).sort((a, b) => Number(b.siteId === form.siteId) - Number(a.siteId === form.siteId) || a.name.localeCompare(b.name));

  const save = async () => {
    setBusy(true);
    try {
      const body = synced
        ? { name: form.name.trim() }
        : { name: form.name.trim(), type: form.type, siteId: form.siteId, ip, uplinkId: form.uplinkId, ...(!equipment && ip && form.ping ? { ping: true } : {}) };
      const saved = equipment ? await api.updateEquipment(equipment.id, body) : await api.createEquipment(body);
      await qc.invalidateQueries({ queryKey: keys.equipments });
      toast.success(equipment ? `Équipement ${saved.name} modifié` : `Équipement ${saved.name} ajouté`);
      onClose();
      if (!equipment) navigate(`/equipments/${saved.id}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        title={equipment ? `Modifier · ${equipment.name}` : 'Ajouter un équipement'}
        footer={
          <>
            <Button disabled={busy} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy} disabled={busy || !nameOk || !ipOk || (!!equipment && !dirty)} onClick={() => void save()}>
              {equipment ? 'Enregistrer' : "Ajouter l'équipement"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className={field}>Nom</span>
            <input className="input" autoFocus maxLength={64} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Switch salon, SLZB-06, PV Routeur…" />
          </label>
          {synced ? (
            <p className="text-xs text-muted">Type, site, adresse et équipement amont viennent de la source {SOURCE_LABELS[equipment.source]}.</p>
          ) : (
            <>
              <label className="block">
                <span className={field}>Type</span>
                <select className="input" value={form.type} onChange={(e) => set({ type: e.target.value as EquipmentType })}>
                  {EQUIPMENT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                </select>
              </label>
              <SiteSelect value={form.siteId} onChange={(siteId) => set({ siteId })} />
              <label className="block">
                <span className={field}>Adresse IP</span>
                <input className="input font-mono text-xs" value={form.ip} onChange={(e) => set({ ip: e.target.value })} placeholder="facultatif" spellCheck={false} />
                {!ipOk && <span className="mt-1 block text-xs text-amber-400">Adresse IPv4 ou IPv6 attendue</span>}
                {equipment?.ip && ip && ip !== equipment.ip && <span className="mt-1 block text-xs text-muted">Les sondes ping et TCP sur {equipment.ip} suivront la nouvelle adresse.</span>}
              </label>
              {!equipment && (
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input type="checkbox" checked={form.ping && !!ip} disabled={!ip} onChange={(e) => set({ ping: e.target.checked })} className="accent-emerald-500" />
                  Créer une sonde ping sur cette adresse
                </label>
              )}
              <label className="block">
                <span className={field}>Équipement amont</span>
                <select className="input" value={form.uplinkId} onChange={(e) => set({ uplinkId: e.target.value })}>
                  <option value="">Aucun</option>
                  {uplinks.map((e) => <option key={e.id} value={e.id}>{e.name}{e.siteId !== form.siteId ? ` · ${siteName(e.siteId) ?? 'sans site'}` : ''}</option>)}
                </select>
                <span className="mt-1 block text-xs text-muted">Ce dont il dépend (switch, passerelle…) : affiché sur sa fiche, ne masque jamais l'état d'une sonde.</span>
              </label>
            </>
          )}
        </div>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        L'équipement ne sera pas enregistré.
      </ConfirmModal>
    </>
  );
}
