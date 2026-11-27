import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Boxes, Check, CircleHelp, DatabaseZap, Server, Shuffle, TriangleAlert } from 'lucide-react';
import { api, type PbsChanges } from '../lib/api';
import { useMe } from '../lib/auth';
import { keys } from '../lib/queries';
import { timeAgo } from '../lib/format';
import { useToast } from '../lib/toast';
import { Button, Checkbox, ConfirmModal, Modal, VerticalTabs } from './ui';

// Changes of the main PBS (hub pbsChanges.ts, homelab#378): datastores removed, groups moved from a datastore to another,
// server replaced. The hub stops at once what can only fail (copy of a gone group) and asks here for the rest; the
// choices of every tab are applied together (the dialog is the preview of the targets).

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const where = (store: string, ns: string) => `${store}${ns ? ` › ${ns}` : ''}`;

// below the backups: refreshed with them (live 'backups')
const changesKey = [...keys.backups, 'changes'] as const;

function usePbsChanges() {
  return useQuery({ queryKey: changesKey, queryFn: api.pbsChanges });
}

const pending = (c: PbsChanges) => (c.server ? 1 : 0) + c.moved.length + c.vanished.length + c.jobs.length + c.nextcloud.length + c.pve.length;

function summary(c: PbsChanges) {
  const parts: string[] = [];
  if (c.server) parts.push('serveur PBS changé');
  if (c.removedStores.length) parts.push(`${plural(c.removedStores.length, 'datastore retiré', 'datastores retirés')} (${c.removedStores.join(', ')})`);
  if (c.moved.length) parts.push(plural(c.moved.length, 'sauvegarde déplacée', 'sauvegardes déplacées'));
  if (c.vanished.length) parts.push(plural(c.vanished.length, 'sauvegarde disparue', 'sauvegardes disparues'));
  if (c.jobs.length) parts.push(`${plural(c.jobs.length, 'job', 'jobs')} sur un datastore retiré`);
  if (c.nextcloud.length + c.pve.length) parts.push(plural(c.nextcloud.length + c.pve.length, 'réglage à corriger ailleurs', 'réglages à corriger ailleurs'));
  return parts.join(' · ');
}

// On the page Sauvegardes, while something is to decide.
export function PbsChangesBanner() {
  const { canManage } = useMe();
  const { data } = usePbsChanges();
  const [open, setOpen] = useState(false);
  if (!data || !pending(data)) return null;
  return (
    <>
      <section className="panel flex flex-col gap-3 border-amber-500/50 bg-amber-500/5 px-4 py-3 text-sm text-zinc-300 md:flex-row md:items-center">
        <Shuffle className="hidden h-5 w-5 shrink-0 text-amber-400 md:block" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-zinc-100">Changements du PBS à traiter</p>
          <p className="text-xs text-muted">{summary(data)}</p>
        </div>
        {canManage ? (
          <Button variant="primary" onClick={() => setOpen(true)}>Traiter</Button>
        ) : (
          <span className="text-xs text-muted">À traiter par un administrateur</span>
        )}
      </section>
      {canManage && open && <PbsChangesDialog open onClose={() => setOpen(false)} data={data} />}
    </>
  );
}

type Tab = 'server' | 'moved' | 'vanished' | 'jobs' | 'elsewhere';

function PbsChangesDialog({ open, onClose, data }: { open: boolean; onClose: () => void; data: PbsChanges }) {
  const qc = useQueryClient();
  const toast = useToast();
  const tabs = useMemo(
    () =>
      [
        data.server && { id: 'server' as const, label: 'Serveur', icon: Server, count: 1 },
        data.moved.length && { id: 'moved' as const, label: 'Déplacées', icon: Shuffle, count: data.moved.length },
        data.vanished.length && { id: 'vanished' as const, label: 'Disparues', icon: TriangleAlert, count: data.vanished.length },
        data.jobs.length && { id: 'jobs' as const, label: 'Jobs du hub', icon: DatabaseZap, count: data.jobs.length },
        data.nextcloud.length + data.pve.length && { id: 'elsewhere' as const, label: 'À corriger ailleurs', icon: Boxes, count: data.nextcloud.length + data.pve.length },
      ].filter((t): t is { id: Tab; label: string; icon: typeof Server; count: number } => !!t),
    [data],
  );
  // a tab emptied meanwhile (applied, solved elsewhere): the first one left
  const [picked, setTab] = useState<Tab>(tabs[0]?.id ?? 'moved');
  const tab = tabs.some((t) => t.id === picked) ? picked : (tabs[0]?.id ?? picked);

  // choices (the dialog is mounted when opened): every move offered (the admin unticks), nothing forgotten unless
  // asked, a datastore per job (the only one left when there is just one)
  const [move, setMove] = useState<Set<string>>(() => new Set(data.moved.map((m) => m.id)));
  const [forget, setForget] = useState<Set<string>>(() => new Set());
  const [targets, setTargets] = useState<Record<string, string>>(() => Object.fromEntries(data.jobs.map((j) => [j.id, data.stores.length === 1 ? data.stores[0] : ''])));

  const [busy, setBusy] = useState(false);
  const jobs = data.jobs.filter((j) => targets[j.id]);
  const moves = data.moved.filter((m) => move.has(m.id));
  const forgets = data.vanished.filter((v) => forget.has(v.id));
  const nothing = !moves.length && !forgets.length && !jobs.length;

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.applyPbsChanges({ move: moves.map((m) => m.id), forget: forgets.map((v) => v.id), jobs: jobs.map((j) => ({ id: j.id, store: targets[j.id] })) });
      const done = [r.moved && plural(r.moved, 'sauvegarde reprise', 'sauvegardes reprises'), r.forgotten && plural(r.forgotten, 'sauvegarde oubliée', 'sauvegardes oubliées'), r.jobs && plural(r.jobs, 'job redirigé', 'jobs redirigés')].filter(Boolean);
      if (done.length) toast.success(done.join(', '));
      if (r.errors.length) toast.error(`Non appliqué : ${r.errors.join(' ; ')}`);
      await qc.invalidateQueries({ queryKey: keys.backups });
      if (!r.errors.length) onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  const choice = [moves.length && plural(moves.length, 'reprise'), forgets.length && plural(forgets.length, 'oubli'), jobs.length && plural(jobs.length, 'job redirigé', 'jobs redirigés')].filter(Boolean).join(' · ');

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      wide="screen"
      title="Changements du PBS"
      footer={
        <>
          <span className="mr-auto hidden min-w-0 self-center truncate text-xs text-muted sm:block">{choice || 'Rien de coché'}</span>
          <Button variant="ghost" onClick={onClose}>Fermer</Button>
          <Button variant="primary" icon={Check} loading={busy} disabled={nothing} onClick={() => void apply()}>Appliquer</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          {data.removedStores.length ? <>Datastores retirés du PBS principal : <b className="text-zinc-200">{data.removedStores.join(', ')}</b> (présents : {data.stores.join(', ') || 'aucun'}). </> : null}
          Les copies déportées des sauvegardes disparues sont déjà suspendues ; le reste attend ton choix. Les cases cochées de tous les onglets sont appliquées ensemble.
        </p>
        <VerticalTabs tabs={tabs} value={tab} onChange={setTab} bodyClassName="pt-4 md:pt-1 md:pl-6">
          {tab === 'server' && data.server && <ServerTab server={data.server} />}
          {tab === 'moved' && (
            <ChoiceTable
              intro="Même namespace et même identifiant, retrouvées dans un autre datastore : leurs réglages (hôte rattaché à la main, seuil de retard, copie déportée, statistiques) passent à la sauvegarde retrouvée, l’ancienne est oubliée. Rien de ce que la nouvelle a déjà n’est remplacé."
              all={data.moved.map((m) => m.id)}
              selected={move}
              onChange={setMove}
              head={['Sauvegarde', 'Déplacement', 'Repris']}
              rows={data.moved.map((m) => ({
                id: m.id,
                cells: [
                  <Label key="l" label={m.label} host={m.fromHost?.name ?? m.toHost?.name} />,
                  <span key="w" className="inline-flex items-center gap-1.5 text-xs text-zinc-300">{where(m.fromStore, m.ns)} <ArrowRight className="h-3 w-3 text-muted" /> {where(m.toStore, m.ns)}</span>,
                  <Carried key="c" carry={m.carry} />,
                ],
              }))}
              toggle={(id, on) => setMove((s) => toggle(s, id, on))}
            />
          )}
          {tab === 'vanished' && (
            <ChoiceTable
              intro="Plus sur le PBS et retrouvées nulle part (ou à plusieurs endroits : à rattacher à la main). Gardées, elles restent signalées sur leur hôte ; cochées, elles sont oubliées du hub (rien n’est supprimé sur le PBS)."
              all={data.vanished.map((v) => v.id)}
              selected={forget}
              onChange={setForget}
              head={['Sauvegarde', 'Datastore', 'Dernière']}
              allLabel="Tout oublier"
              rows={data.vanished.map((v) => ({
                id: v.id,
                cells: [
                  <Label key="l" label={v.label} host={v.host?.name} note={v.candidates > 1 ? `${v.candidates} correspondances : rattacher à la main` : undefined} />,
                  <span key="s" className="text-xs text-zinc-300">{where(v.store, v.ns)}{v.storeRemoved && <span className="text-amber-400"> (retiré)</span>}</span>,
                  <span key="d" className="text-xs text-muted">{v.lastBackup ? timeAgo(v.lastBackup) : '—'}</span>,
                ],
              }))}
              toggle={(id, on) => setForget((s) => toggle(s, id, on))}
            />
          )}
          {tab === 'jobs' && (
            <section className="space-y-3">
              <p className="text-xs text-muted">Jobs de sauvegarde du hub qui écrivent sur un datastore retiré : ils échouent à chaque exécution. Choisis le datastore où ils écriront désormais ; l’agent de l’hôte reçoit la nouvelle définition.</p>
              <table className="w-full text-sm">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th">Job</th>
                    <th className="th">Actuel</th>
                    <th className="th">Nouveau datastore</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.jobs.map((j) => (
                    <tr key={j.id}>
                      <td className="td"><Label label={j.name} host={j.host.name} /></td>
                      <td className="td text-xs text-amber-400">{where(j.store, j.ns)}</td>
                      <td className="td">
                        <select className="input h-8 py-0 text-xs" value={targets[j.id] ?? ''} onChange={(e) => setTargets((t) => ({ ...t, [j.id]: e.target.value }))}>
                          <option value="">— ne pas changer —</option>
                          {data.stores.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {tab === 'elsewhere' && (
            <section className="space-y-4 text-xs">
              <p className="text-muted">Réglages qui visent un datastore retiré et que le hub ne modifie pas d’ici : à corriger à l’endroit indiqué. Ils disparaissent de cette liste une fois corrigés.</p>
              {data.nextcloud.length > 0 && (
                <div>
                  <p className="font-medium text-zinc-100">Plugin Nextcloud</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-zinc-300">
                    {data.nextcloud.map((n) => (
                      <li key={n.host.id}>
                        <Link className="text-emerald-300 hover:underline" to={`/hosts/${n.host.id}`}>{n.host.name}</Link> : datastore{n.stores.length > 1 ? 's' : ''} {n.stores.join(', ')} — à changer dans le plugin Nextcloud de l’hôte
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.pve.length > 0 && (
                <div>
                  <p className="font-medium text-zinc-100">Jobs de sauvegarde Proxmox VE</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-zinc-300">
                    {data.pve.map((p) => (
                      <li key={`${p.cluster}/${p.job}`}>
                        {p.cluster} · job <code>{p.job}</code> : stockage <code>{p.storage}</code> → datastore {p.store} ({plural(p.guests, 'VM / CT', 'VM / CT')}) — à changer dans Proxmox VE (stockage ou job)
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </VerticalTabs>
      </div>
    </Modal>
  );
}

function Label({ label, host, note }: { label: string; host?: string | null; note?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-zinc-100">{label}</div>
      {(host || note) && <div className="truncate text-xs text-muted">{[host, note].filter(Boolean).join(' · ')}</div>}
    </div>
  );
}

function Carried({ carry }: { carry: PbsChanges['moved'][number]['carry'] }) {
  const items = [carry.hostId && 'hôte', carry.staleHours && 'seuil', carry.offsite && 'copie déportée'].filter(Boolean);
  return (
    <div className="text-xs">
      <span className={items.length ? 'text-zinc-300' : 'text-muted'}>{items.length ? items.join(', ') : 'statistiques'}</span>
      {carry.conflict && <div className="text-amber-400">{carry.conflict}</div>}
    </div>
  );
}

// A list of items to tick, with a box to tick them all.
function ChoiceTable({ intro, head, rows, all, selected, onChange, toggle, allLabel = 'Tout cocher' }: {
  intro: string;
  head: string[];
  rows: { id: string; cells: ReactNode[] }[];
  all: string[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  toggle: (id: string, on: boolean) => void;
  allLabel?: string;
}) {
  const every = all.every((id) => selected.has(id));
  const some = all.some((id) => selected.has(id));
  return (
    <section className="space-y-3">
      <p className="text-xs text-muted">{intro}</p>
      <table className="w-full text-sm">
        <thead className="border-b border-line">
          <tr>
            <th className="th w-8"><Checkbox checked={every} indeterminate={some} onChange={(v) => onChange(new Set(v ? all : []))} label={allLabel} /></th>
            {head.map((h) => <th key={h} className="th">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.id} className={clsx(!selected.has(r.id) && 'opacity-70')}>
              <td className="td"><Checkbox checked={selected.has(r.id)} onChange={(v) => toggle(r.id, v)} label={r.id} /></td>
              {r.cells.map((c, i) => <td key={i} className="td">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Another agent or certificate for the main PBS: the same server, or a new one whose tokens the hub creates.
function ServerTab({ server }: { server: NonNullable<PbsChanges['server']> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'same' | 'new' | null>(null);
  const why = [server.agentChanged && 'l’agent qui administre le PBS', server.certChanged && 'l’empreinte de son certificat'].filter(Boolean).join(' et ');

  const resolve = async (sameServer: boolean) => {
    setBusy(sameServer ? 'same' : 'new');
    try {
      const r = await api.resolvePbsServerChange(sameServer);
      if (sameServer) toast.success('Même serveur : rien d’autre à faire');
      else {
        toast.success(`Nouveau serveur : ${plural(r.hosts.length, 'jeton d’hôte créé', 'jetons d’hôtes créés')}${r.reader ? ', jeton lecteur du PBS de secours créé' : ''}${r.revoked.length ? `, ${plural(r.revoked.length, 'ancien jeton révoqué', 'anciens jetons révoqués')}` : ''}`);
        if (r.errors.length) toast.error(r.errors.join(' ; '));
      }
      setConfirm(false);
      await qc.invalidateQueries({ queryKey: keys.backups });
      await qc.invalidateQueries({ queryKey: ['settings', 'pbs'] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-4">
      <p className="text-zinc-300">
        Depuis {timeAgo(server.at)}, {why || 'le PBS principal'} a changé
        {server.url !== server.currentUrl ? <> (adresse : <code>{server.url}</code> → <code>{server.currentUrl}</code>)</> : null}.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-raised/20 p-4">
          <p className="font-medium text-zinc-100">Même serveur</p>
          <p className="mt-1 text-xs text-muted">Déplacé, réinstallé dans un conteneur, certificat renouvelé… Les jetons et les sauvegardes y sont toujours : rien d’autre à faire.</p>
          <Button className="mt-3" loading={busy === 'same'} disabled={!!busy} onClick={() => void resolve(true)}>Même serveur</Button>
        </div>
        <div className="rounded-lg border border-line bg-raised/20 p-4">
          <p className="font-medium text-zinc-100">Nouveau serveur</p>
          <p className="mt-1 text-xs text-muted">
            Les jetons des hôtes et le jeton lecteur du PBS de secours sont créés sur le nouveau PBS (mêmes identifiants) et transmis aux agents ; ceux de l’ancien
            sont révoqués s’il répond encore. Les sauvegardes de l’ancien apparaîtront ensuite comme déplacées ou disparues.
          </p>
          <Button className="mt-3" variant="primary" disabled={!!busy} onClick={() => setConfirm(true)}>Nouveau serveur…</Button>
        </div>
      </div>
      <p className="flex items-start gap-1.5 text-xs text-muted"><CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0" />Tant que ce choix n’est pas fait, les droits des jetons ne sont pas étendus aux nouveaux datastores.</p>
      <ConfirmModal
        open={confirm}
        onClose={() => !busy && setConfirm(false)}
        onConfirm={() => void resolve(false)}
        title="Passer au nouveau serveur PBS ?"
        confirmLabel="Nouveau serveur"
        loading={busy === 'new'}
      >
        <ul className="list-disc space-y-1 pl-5">
          <li>jeton de chaque hôte créé sur le nouveau PBS, puis transmis à son agent (un hôte hors ligne le reçoit à sa reconnexion) ;</li>
          <li>jeton lecteur du PBS de secours créé sur le nouveau PBS ;</li>
          <li>jetons de l’ancien PBS révoqués par son agent s’il répond (sinon : à révoquer à la main).</li>
        </ul>
      </ConfirmModal>
    </section>
  );
}
