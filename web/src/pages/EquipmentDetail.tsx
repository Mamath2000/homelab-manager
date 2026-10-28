import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, Pencil, Radio, Router, Trash2 } from 'lucide-react';
import { AlertTimeline } from '../components/AlertTimeline';
import { EquipmentModal } from '../components/Equipment';
import { SOURCE_LABELS, TYPE_LABELS, equipmentTone, useSiteName } from '../lib/equipment';
import { HeaderTitle } from '../components/HeaderSlot';
import { ProbesPanel } from '../components/Probes';
import { Badge, Button, ConfirmModal, Empty, Panel, Spinner, StatusDot } from '../components/ui';
import { api, type Equipment } from '../lib/api';
import { useMe } from '../lib/auth';
import { dateTime, timeAgo } from '../lib/format';
import { cellLabel, levelTone } from '../lib/monitoring';
import { keys, useEquipment, useEquipments, useStatus } from '../lib/queries';
import { toneBadge, type Tone } from '../lib/status';
import { useToast } from '../lib/toast';

const toneLabel: Record<Tone, string> = { ok: 'OK', warn: 'Avertissement', bad: 'Alerte', neutral: 'Non suivi', unknown: 'Inconnu', info: 'Info' };

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-zinc-200">{children}</dd>
    </div>
  );
}

const equipmentLink = (e: Pick<Equipment, 'id' | 'name'>) => <Link key={e.id} to={`/equipments/${e.id}`} className="text-emerald-400 hover:underline">{e.name}</Link>;

// What the source of a synced equipment reports (connection, firmware...), at its last synchronisation.
function NativePanel({ equipment }: { equipment: Equipment }) {
  const { data: status } = useStatus();
  const d = status?.equipments[equipment.id]?.domains.system;
  const source = SOURCE_LABELS[equipment.source];
  return (
    <Panel title={`Remonté par ${source}`} icon={Radio} actions={equipment.native && <span className="text-xs text-muted">synchronisé {timeAgo(equipment.native.syncedAt)}</span>}>
      {!d || d.level === 'unknown' ? (
        <p className="text-sm text-muted">{d?.reason ?? 'Pas encore synchronisé'} : l'état remonté par {source} n'est pas connu.</p>
      ) : !d.checks.length ? (
        <p className="text-sm text-muted">Rien à signaler.</p>
      ) : (
        <ul className="space-y-1.5">
          {d.checks.map((c) => (
            <li key={c.key} className="flex items-center gap-2.5 text-sm">
              <Badge tone={levelTone[c.level]}>{cellLabel[c.level]}</Badge>
              <span className="text-zinc-200">{c.label}</span>
              {c.reason && <span className="min-w-0 truncate text-muted">{c.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

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
  const tone = equipmentTone(status, e);
  const uplink = all?.find((x) => x.id === e.uplinkId);
  const below = (all ?? []).filter((x) => x.uplinkId === e.id);

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
        <Panel
          title="Équipement"
          icon={Router}
          actions={
            canManage && (
              <>
                <Button size="sm" icon={Pencil} onClick={() => setEditing(true)}>Modifier</Button>
                <Button size="sm" variant="danger" icon={Trash2} aria-label={`Supprimer ${e.name}`} title="Supprimer" onClick={() => setRemoving(true)} />
              </>
            )
          }
        >
          <dl className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-6 gap-y-3">
            <Fact label="Type">{TYPE_LABELS[e.type]}</Fact>
            <Fact label="Site">{siteName(e.siteId) ?? '—'}</Fact>
            <Fact label="Adresse IP"><span className="font-mono text-xs">{e.ip ?? '—'}</span></Fact>
            <Fact label="Amont">{uplink ? equipmentLink(uplink) : '—'}</Fact>
            {below.length > 0 && <Fact label="En aval">{below.flatMap((x, i) => (i ? [', ', equipmentLink(x)] : [equipmentLink(x)]))}</Fact>}
            <Fact label="Source">{SOURCE_LABELS[e.source]}{e.externalId && <span className="ml-1.5 font-mono text-xs text-muted">{e.externalId}</span>}</Fact>
            <Fact label="Ajouté le">{dateTime(e.createdAt)}</Fact>
          </dl>
        </Panel>

        <AlertTimeline kind="equipment" id={e.id} />
        {e.source !== 'manual' && <NativePanel equipment={e} />}
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
