import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, RefreshCw, Router, Settings, Trash2 } from 'lucide-react';
import { AlertTimeline } from '../components/AlertTimeline';
import { EquipmentModal } from '../components/Equipment';
import { SOURCE_LABELS, TYPE_LABELS, equipmentTone, useSiteName } from '../lib/equipment';
import { HeaderTitle } from '../components/HeaderSlot';
import { StripItem } from '../components/StripItem';
import { ProbesPanel } from '../components/Probes';
import { Badge, Button, ConfirmModal, Empty, Spinner, StatusDot } from '../components/ui';
import { api, type Equipment } from '../lib/api';
import { useMe } from '../lib/auth';
import { dateTime, timeAgo } from '../lib/format';
import { cellLabel, levelTone } from '../lib/monitoring';
import { keys, useEquipment, useEquipments, useStatus } from '../lib/queries';
import { toneBadge, type Tone } from '../lib/status';
import { useToast } from '../lib/toast';

const toneLabel: Record<Tone, string> = { ok: 'OK', warn: 'Avertissement', bad: 'Alerte', neutral: 'Non suivi', unknown: 'Inconnu', info: 'Info' };

const equipmentLink = (e: Pick<Equipment, 'id' | 'name'>) => <Link key={e.id} to={`/equipments/${e.id}`} className="text-emerald-400 hover:underline">{e.name}</Link>;

export function EquipmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: equipment, isLoading } = useEquipment(id);
  if (isLoading) return <div className="flex justify-center p-20"><Spinner /></div>;
  if (!equipment) {
    return (
      <div className="panel">
        <Empty icon={Router} title="Équipement introuvable">
          <Link to="/equipments" className="text-emerald-400 hover:underline">Retour aux équipements</Link>
        </Empty>
      </div>
    );
  }
  // a fresh page per equipment: nothing of the previous one stays (dialogs)
  return <EquipmentPage key={equipment.id} equipment={equipment} />;
}

function EquipmentPage({ equipment: e }: { equipment: Equipment }) {
  const { canManage } = useMe();
  const { data: all } = useEquipments();
  const { data: status } = useStatus();
  const siteName = useSiteName();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const synced = e.source !== 'manual';
  // what the source reports (connection, load...), as the facts of the equipment
  const native = status?.equipments[e.id]?.domains.system;
  const tone = equipmentTone(status, e);
  const uplink = all?.find((x) => x.id === e.uplinkId);
  const below = (all ?? []).filter((x) => x.uplinkId === e.id);

  // a new poll of the source now (all the controllers; the equipments are rewritten as at each poll)
  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.pollOmada();
      qc.invalidateQueries({ queryKey: keys.equipments });
      qc.invalidateQueries({ queryKey: keys.status });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteEquipment(e.id);
      await qc.invalidateQueries({ queryKey: keys.equipments });
      toast.success(`Équipement ${e.name} supprimé`);
      navigate('/equipments');
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <HeaderTitle
        icon={Router}
        title={e.name}
        back={
          <Link to="/equipments" title="Retour aux équipements" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-sm text-muted transition hover:bg-raised hover:text-zinc-100">
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Équipements</span>
          </Link>
        }
        status={
          <span className={clsx('inline-flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset', toneBadge[tone])}>
            <StatusDot tone={tone} />
            {toneLabel[tone]}
          </span>
        }
      />

      <div className="space-y-5">
        <section className="panel">
          <dl className="flex flex-wrap lg:flex-nowrap">
            <StripItem label="Type">{TYPE_LABELS[e.type]}</StripItem>
            <StripItem label="Site">{siteName(e.siteId) ?? '—'}</StripItem>
            <StripItem label="Adresse IP"><span className="font-mono text-xs">{e.ip ?? '—'}</span></StripItem>
            <StripItem label="Amont">{uplink ? equipmentLink(uplink) : '—'}</StripItem>
            {below.length > 0 && <StripItem label="En aval">{below.flatMap((x, i) => (i ? [', ', equipmentLink(x)] : [equipmentLink(x)]))}</StripItem>}
            <StripItem label="Source" grow>{SOURCE_LABELS[e.source]}{e.externalId && <span className="ml-1.5 font-mono text-xs text-muted">{e.externalId}</span>}</StripItem>
            {synced && (
              <>
                {!native || native.level === 'unknown' ? (
                  <StripItem label="Connexion"><span className="text-muted">{native?.reason ?? 'Pas encore synchronisé'}</span></StripItem>
                ) : (
                  native.checks.map((c) => (
                    <StripItem key={c.key} label={c.label}>
                      <Badge tone={levelTone[c.level]}>{cellLabel[c.level]}</Badge>
                      {c.reason && <span className="ml-1.5 text-xs text-muted">{c.reason}</span>}
                    </StripItem>
                  ))
                )}
                <StripItem label="Synchronisé">{e.native ? <span title={dateTime(e.native.syncedAt)}>{timeAgo(e.native.syncedAt)}</span> : '—'}</StripItem>
              </>
            )}
            <StripItem label="Ajouté le">{dateTime(e.createdAt)}</StripItem>
            {canManage && (
              <div className="flex shrink-0 items-center gap-2 self-center px-4 py-2.5">
                {synced && <Button icon={RefreshCw} loading={refreshing} title={`Actualiser : relire ${SOURCE_LABELS[e.source]} maintenant`} aria-label="Actualiser" className="h-11! w-11! px-0! [&>svg]:h-5 [&>svg]:w-5" onClick={refresh} />}
                <Button icon={Settings} title="Options" aria-label="Options" className="h-11! w-11! px-0! [&>svg]:h-5 [&>svg]:w-5" onClick={() => setEditing(true)} />
                <Button variant="danger" icon={Trash2} aria-label={`Supprimer ${e.name}`} title="Supprimer" className="h-11! w-11! px-0! [&>svg]:h-5 [&>svg]:w-5" onClick={() => setRemoving(true)} />
              </div>
            )}
          </dl>
        </section>

        <AlertTimeline kind="equipment" id={e.id} />
        <ProbesPanel owner={{ kind: 'equipment', equipment: e }} />
      </div>

      {editing && <EquipmentModal equipment={e} onClose={() => setEditing(false)} />}
      <ConfirmModal open={removing} onClose={() => setRemoving(false)} onConfirm={() => void remove()} title="Supprimer l'équipement" confirmLabel="Supprimer" danger loading={busy}>
        <b>{e.name}</b>, {e.probes.length ? `ses ${e.probes.length} sonde(s)` : 'ses sondes'} et son historique d'alertes seront supprimés.
        {below.length > 0 && <> Les équipements en aval ({below.map((x) => x.name).join(', ')}) n'auront plus d'amont.</>}
      </ConfirmModal>
    </>
  );
}
