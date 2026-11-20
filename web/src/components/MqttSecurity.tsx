import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ChevronLeft, ChevronRight, Ghost, KeyRound, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { api, type MqttAccount, type MqttAnonymous, type MqttHubRole, type MqttRefused } from '../lib/api';
import { timeAgo } from '../lib/format';
import { brokerCounts, stillRefused } from '../lib/roles';
import { keys } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge, Button, ConfirmModal, CopyField, Modal, Segmented, Spinner } from './ui';

// one line of the accounts dialog: a refused client, an account or an anonymous client
type AccountRow = { kind: 'refused'; c: MqttRefused } | { kind: 'account'; a: MqttAccount } | { kind: 'anonymous'; c: MqttAnonymous };
type RowFilter = 'all' | 'error' | 'anonymous' | 'accounts';
const PAGE_SIZE = 15;
const rowText = (r: AccountRow) => (r.kind === 'account' ? r.a.username : r.kind === 'refused' ? `${r.c.clientId} ${r.c.address} ${r.c.account ?? ''}` : `${r.c.clientId} ${r.c.address}`).toLowerCase();

// The options of a broker role, in the foot of its card: to secure it (certificates by the CA of the hub, listener TLS, hub
// account by certificate, dynamic-security run by the agent of the host); once secured, to reset it, to accept or refuse the
// anonymous clients and to manage its accounts. Nothing when the management of accounts is not available on this broker.
// The clients of a broker the hub runs the accounts of, as on the page of its host: read when the card shows, no polling
function BrokerStats({ role }: { role: MqttHubRole }) {
  const q = useQuery({ queryKey: ['mqtt-accounts', role.id], queryFn: () => api.mqttAccounts(role.id), refetchOnWindowFocus: false });
  if (q.error) return <p className="max-w-xs text-xs text-red-400">{(q.error as Error).message}</p>;
  const { accounts, connected, anonymous, refused } = brokerCounts(q.data);
  const n = (v: number) => (q.isLoading ? '…' : v);
  return (
    <ul className="min-w-44 space-y-1 text-xs">
      <li><b className="text-zinc-100">{n(accounts)}</b> <span className="text-muted">compte{accounts > 1 ? 's' : ''} enregistré{accounts > 1 ? 's' : ''}</span></li>
      <li><b className="text-zinc-100">{n(connected)}</b> <span className="text-muted">connecté{connected > 1 ? 's' : ''}</span></li>
      <li>{anonymous > 0 ? <Badge tone="warn">{anonymous} anonyme{anonymous > 1 ? 's' : ''} connecté{anonymous > 1 ? 's' : ''}</Badge> : <span className="text-muted">aucun anonyme connecté</span>}</li>
      <li>{refused > 0 ? <Badge tone="bad">{refused} client{refused > 1 ? 's' : ''} refusé{refused > 1 ? 's' : ''}</Badge> : <span className="text-muted">aucun client refusé</span>}</li>
    </ul>
  );
}

// The pieces are handed to the card (children) to place where they belong: the anonymous state in its details, the reset as a
// discreet link, the buttons in its foot; the confirmation windows are rendered here.
export interface BrokerCardSlots {
  // foot of the card, right-aligned
  buttons: ReactNode;
  // icon button of the header, beside the pencil: the anonymous clients (green: refused, red: accepted), a click switches
  anonymous: ReactNode;
  // discreet link under the details
  reset: ReactNode;
  // the clients of the broker, beside the details: accounts, connected, anonymous, refused
  stats: ReactNode;
}
export function BrokerCardControls({ role, onAccounts, children }: { role: MqttHubRole; onAccounts: () => void; children: (slots: BrokerCardSlots) => ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'enable' | 'reset' | 'anonymous-off' | 'anonymous-on' | null>(null);
  const [busy, setBusy] = useState(false);
  const wanted = role.security.state !== 'unavailable';
  const q = useQuery({ queryKey: ['mqtt-security', role.id], queryFn: () => api.mqttSecurity(role.id), enabled: wanted, refetchOnWindowFocus: false });
  const v = q.data;
  const state = v?.state ?? role.security.state;
  const hubManaged = !!v?.enabledAt || !!role.security.managed;
  const checks = v?.report?.checks ?? [];
  const blocked = !!v && (!!v.error || !v.report?.eligible);

  const run = async (what: 'enable' | 'reset') => {
    setBusy(true);
    try {
      if (what === 'enable') await api.enableMqttSecurity(role.id);
      else await api.resetMqttSecurity(role.id);
      toast.success(what === 'enable' ? 'Broker sécurisé' : 'Broker réinitialisé');
      setConfirm(null);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.roles }), qc.invalidateQueries({ queryKey: keys.mqttBrokers }), qc.invalidateQueries({ queryKey: ['mqtt-security', role.id] })]);
    } catch (err) {
      toast.error((err as Error).message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const manageable = state === 'active' && hubManaged;
  const anon = useQuery({ queryKey: ['mqtt-anonymous', role.id], queryFn: () => api.mqttAnonymous(role.id), enabled: manageable, refetchOnWindowFocus: false });
  // the anonymous clients connected now, listed in the confirmation that refuses them
  const still = useQuery({ queryKey: ['mqtt-accounts', role.id], queryFn: () => api.mqttAccounts(role.id), enabled: confirm === 'anonymous-off', refetchOnWindowFocus: false });
  const stillAnonymous = (still.data?.anonymous ?? []).filter((a) => a.connected);
  const setAnonymous = async (allowed: boolean) => {
    setBusy(true);
    try {
      await api.setMqttAnonymous(role.id, allowed);
      toast.success(allowed ? 'Connexions anonymes acceptées' : 'Connexions anonymes refusées');
      setConfirm(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ['mqtt-anonymous', role.id] }), qc.invalidateQueries({ queryKey: ['mqtt-accounts', role.id] }), qc.invalidateQueries({ queryKey: keys.roles })]);
    } catch (err) {
      toast.error((err as Error).message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const allowed = anon.data?.allowed;
  // not managed by the hub: same icon, same place, but only an indicator (the state comes from the role's own probe)
  const readOnlyAnonymous = role.anonymous == null ? null : (
    <Button
      size="sm"
      icon={Ghost}
      tabIndex={-1}
      aria-label={`Connexions anonymes ${role.anonymous ? 'acceptées' : 'refusées'}`}
      title={role.anonymous ? 'Connexions anonymes acceptées (broker non géré par HLM : à changer sur le broker)' : 'Connexions anonymes refusées'}
      className={clsx('cursor-default', role.anonymous ? '!border-red-500/50 !text-red-400 hover:!bg-transparent' : '!border-emerald-500/50 !text-emerald-400 hover:!bg-transparent')}
    />
  );
  const slots: BrokerCardSlots = {
    buttons: (
      <>
        {state === 'available' && <Button size="sm" icon={ShieldCheck} disabled={busy} onClick={() => setConfirm('enable')}>Sécuriser ce broker</Button>}
        {state === 'active' && !hubManaged && !q.isLoading && <span className="text-xs text-muted">dynamic-security chargé, géré en dehors de HLM</span>}
        {manageable && <Button size="sm" icon={Users} onClick={onAccounts}>Gérer les comptes</Button>}
      </>
    ),
    anonymous: manageable ? (
      <Button
        size="sm"
        icon={Ghost}
        aria-label={anon.data ? `Connexions anonymes ${allowed ? 'acceptées' : 'refusées'}` : 'Connexions anonymes'}
        title={
          anon.data?.configurable === false ? "L'agent de l'hôte ne répond pas ou est trop ancien"
            : anon.error ? (anon.error as Error).message
              : !anon.data ? 'Connexions anonymes : lecture…'
                : allowed ? 'Connexions anonymes acceptées : cliquer pour les refuser' : 'Connexions anonymes refusées : cliquer pour les accepter'
        }
        disabled={anon.isLoading || !!anon.error || busy || anon.data?.configurable === false}
        className={clsx(anon.data && (allowed ? '!border-red-500/50 !text-red-400 hover:!bg-red-500/10' : '!border-emerald-500/50 !text-emerald-400 hover:!bg-emerald-500/10'))}
        onClick={() => setConfirm(allowed ? 'anonymous-off' : 'anonymous-on')}
      />
    ) : readOnlyAnonymous,
    stats: manageable ? <BrokerStats role={role} /> : null,
    reset: manageable ? (
      <button type="button" disabled={busy} onClick={() => setConfirm('reset')} className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted underline decoration-dotted underline-offset-2 transition hover:text-red-300 disabled:opacity-50">
        <RotateCcw className="h-3 w-3" aria-hidden />
        Réinitialiser le broker
      </button>
    ) : null,
  };
  if (!wanted) return <>{children({ buttons: null, anonymous: readOnlyAnonymous, reset: null, stats: null })}</>;
  return (
    <>
      {children(slots)}
      <ConfirmModal
        open={confirm === 'anonymous-off'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void setAnonymous(false)}
        title="Refuser les clients anonymes"
        confirmLabel="Refuser et redémarrer le broker"
        danger
        loading={busy}
      >
        <p>
          Le broker <b>{role.name}</b> va être redémarré (tous ses clients déconnectés quelques secondes), puis <b>refusera</b> toute connexion sans compte. Les
          appareils concernés s'afficheront dans les clients refusés. Réversible : « Anonymes » dans la carte du rôle.
        </p>
        {still.isLoading ? (
          <p className="mt-2 text-xs text-muted">Recherche des clients anonymes connectés…</p>
        ) : stillAnonymous.length > 0 ? (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {stillAnonymous.length} client{stillAnonymous.length > 1 ? 's' : ''} anonyme{stillAnonymous.length > 1 ? 's sont' : ' est'} encore connecté{stillAnonymous.length > 1 ? 's' : ''} :{' '}
            <span className="font-mono">{stillAnonymous.map((a) => a.clientId).join(', ')}</span>. {stillAnonymous.length > 1 ? 'Ils seront coupés' : 'Il sera coupé'}.
          </div>
        ) : (
          <p className="mt-2 text-xs text-emerald-400">Aucun client anonyme connecté.</p>
        )}
      </ConfirmModal>
      <ConfirmModal
        open={confirm === 'anonymous-on'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void setAnonymous(true)}
        title="Accepter les clients anonymes"
        confirmLabel="Accepter et redémarrer le broker"
        loading={busy}
      >
        Le broker <b>{role.name}</b> va être redémarré (quelques secondes) et acceptera de nouveau les connexions sans compte, avec les droits du rôle <code>legacy</code> : tout
        appareil du réseau pourra y publier.
      </ConfirmModal>
      <ConfirmModal
        open={confirm === 'enable'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run('enable')}
        title="Sécuriser ce broker"
        confirmLabel="Sécuriser et redémarrer le broker"
        danger
        loading={busy}
        disabled={q.isLoading || blocked}
      >
        <p>
          Le broker <b>{role.name}</b> va être redémarré et ses clients déconnectés quelques secondes. Le hub y installe ses certificats (CA du hub), son compte
          d'administration et le plugin dynamic-security. <b>Les connexions avec un utilisateur inconnu seront ensuite refusées</b> ; les connexions anonymes restent
          acceptées jusqu'à ce que vous les refusiez. L'agent ajoute des fichiers sans modifier les vôtres ; en cas d'échec il les retire et redémarre.
        </p>
        <p className="mt-2 text-[11px] font-medium tracking-wide text-muted uppercase">Contrôles de l'agent</p>
        {q.isLoading ? (
          <Spinner />
        ) : v?.error ? (
          <p className="text-xs text-red-400">{v.error}</p>
        ) : (
          <ul className="mt-1 space-y-0.5 text-xs">
            {checks.map((c, i) => (
              <li key={i} className={c.level === 'error' ? 'text-red-400' : c.level === 'warn' ? 'text-amber-400' : 'text-muted'}>
                {c.level === 'error' ? '✗' : c.level === 'warn' ? '!' : '·'} {c.detail}
              </li>
            ))}
          </ul>
        )}
      </ConfirmModal>
      <ConfirmModal
        open={confirm === 'reset'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run('reset')}
        title="Réinitialiser le broker"
        confirmLabel="Réinitialiser et redémarrer le broker"
        danger
        loading={busy}
      >
        <p>
          Le broker <b>{role.name}</b> va être redémarré avec sa configuration d'origine, comme avant l'activation : <b>sans compte ni ACL</b>.
        </p>
        {v?.report?.originAnonymous === false ? (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            Sa configuration d'origine <b>refuse les connexions anonymes</b> (<code>allow_anonymous</code> absent ou <code>false</code>) : sans compte, <b>plus aucun client ne
            pourra se connecter</b>.
          </div>
        ) : (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            <b>
              Connexions anonymes acceptées (<code>allow_anonymous true</code>)
            </b>{' '}
            : n'importe quel appareil du réseau pourra publier et s'abonner sur tous les topics, y compris les commandes de Home Assistant.
          </div>
        )}
        <p className="mt-2">
          <b>Rien n'est conservé</b> : les comptes et les rôles du broker, les certificats et la clé du hub, le compte du rôle (qui repasse en anonyme) sont supprimés
          définitivement. Une nouvelle activation repart de zéro : chaque appareil devra recevoir un nouveau compte.
        </p>
      </ConfirmModal>
    </>
  );
}

// The accounts of the broker, in a dialog opened from its role (and from its host): name and password, with the connection state. A password is shown once, when it is made.
export function MqttAccountsModal({ role, onClose }: { role: MqttHubRole; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['mqtt-accounts', role.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.mqttAccounts(role.id), refetchInterval: 30_000, refetchOnWindowFocus: false });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ username: string; password: string } | null>(null);
  const [changing, setChanging] = useState<MqttAccount | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [deleting, setDeleting] = useState<MqttAccount | null>(null);
  // a refused connection the account is made for: its client id, the name to give (the log has no user name)
  const [forClient, setForClient] = useState<MqttRefused | null>(null);
  const [clientUser, setClientUser] = useState('');
  const [clientPassword, setClientPassword] = useState('');
  // the list is filtered and paged in the dialog: clients that change their id at each try would fill the screen
  const [filter, setFilter] = useState<RowFilter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const done = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    done(async () => {
      const r = await api.createMqttAccount(role.id, username.trim(), password || undefined);
      setUsername('');
      setPassword('');
      setShown(r);
    });
  const createForClient = () =>
    done(async () => {
      const r = await api.createMqttAccount(role.id, clientUser.trim(), clientPassword || undefined, forClient!.clientId);
      setForClient(null);
      setShown(r);
    });
  const change = () =>
    done(async () => {
      const r = await api.setMqttAccountPassword(role.id, changing!.username, newPassword || undefined);
      setChanging(null);
      setNewPassword('');
      setShown(r);
    });
  const forget = (c: MqttRefused) =>
    done(async () => {
      await api.forgetMqttRefused(role.id, c.clientId);
    });
  const forgetAnonymous = (clientId: string) =>
    done(async () => {
      await api.forgetMqttAnonymous(role.id, clientId);
    });
  const clearAll = () =>
    done(async () => {
      await api.clearMqttRefused(role.id);
    });
  const remove = () =>
    done(async () => {
      await api.deleteMqttAccount(role.id, deleting!.username);
      toast.success(`Compte ${deleting!.username} supprimé`);
      setDeleting(null);
    });

  const accounts = q.data?.accounts ?? [];
  const refused = q.data?.refused ?? [];
  const anonymousClients = q.data?.anonymous ?? [];
  // anonymous clients without rights connect but can neither publish nor subscribe: for the administrator, they are refused
  const anonymousMute = q.data?.anonymousAllowed === false && q.data?.anonymousAccepted !== false;
  const rows: AccountRow[] = [
    ...refused.map((c) => ({ kind: 'refused' as const, c })),
    ...accounts.map((a) => ({ kind: 'account' as const, a })),
    ...anonymousClients.map((c) => ({ kind: 'anonymous' as const, c })),
  ];
  const inError = (r: AccountRow) => r.kind === 'refused' || (r.kind === 'anonymous' && anonymousMute);
  const ofFilter = (r: AccountRow, f: RowFilter) => f === 'all' || (f === 'error' ? inError(r) : f === 'anonymous' ? r.kind === 'anonymous' : r.kind === 'account');
  const count = (f: RowFilter) => rows.filter((r) => ofFilter(r, f)).length;
  const filters: { id: RowFilter; label: string }[] = [
    { id: 'all', label: `Tous · ${rows.length}` },
    { id: 'error', label: `En erreur · ${count('error')}` },
    { id: 'anonymous', label: `Anonymes · ${count('anonymous')}` },
    { id: 'accounts', label: `Comptes · ${count('accounts')}` },
  ];
  const needle = search.trim().toLowerCase();
  const visible = rows.filter((r) => ofFilter(r, filter) && (!needle || rowText(r).includes(needle)));
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const pageRows = visible.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={`Comptes MQTT · ${role.name}`}
        wide="screen"
        footer={
          <>
            {refused.length + anonymousClients.length > 0 && (
              <Button icon={X} disabled={busy} onClick={() => void clearAll()} title="Vide la liste des clients refusés et anonymes (ils reviennent à leur prochaine tentative)">
                Retirer tous les clients refusés
              </Button>
            )}
            <Button icon={RefreshCw} loading={q.isFetching} disabled={q.isFetching} onClick={() => void q.refetch()}>Actualiser</Button>
            <Button variant="ghost" onClick={onClose}>Fermer</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted">
            Un compte donne accès à tous les topics du broker. Les clients qui se connectent sans compte (anonymes) sont listés aussi : « Créer » leur prépare un compte pour la migration. Un appareil configuré avec un identifiant qui n'est pas dans cette liste est refusé : il apparaît alors en tête de liste
            (« client refusé », avec son identifiant de client) et le bouton Créer lui fait un compte ; les connexions anonymes restent acceptées.
          </p>
          {q.isLoading ? (
            <Spinner />
          ) : q.error ? (
            <p className="text-xs text-red-400">{(q.error as Error).message}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented label="Type" options={filters} value={filter} onChange={(f) => (setFilter(f), setPage(0))} />
                <label className="relative block min-w-48 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted md:top-2" />
                  <input className="input pl-8" placeholder="Client, compte ou adresse…" value={search} onChange={(e) => (setSearch(e.target.value), setPage(0))} />
                </label>
              </div>
              <table className="w-full table-fixed text-sm">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th">Compte</th>
                    <th className="th w-40">Connexion</th>
                    <th className="th w-32" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {pageRows.map((r) => {
                    if (r.kind === 'refused') {
                      const c = r.c;
                      return (
                        <tr key={`refused:${c.clientId}`} className={stillRefused(c) ? 'bg-red-500/5' : 'bg-amber-500/5'}>
                          <td className="td truncate font-mono text-xs text-zinc-100" title={c.clientId}>
                            {c.clientId}
                            <span className={clsx('ml-2 font-sans', stillRefused(c) ? 'text-red-300' : 'text-amber-300')}>
                              {!c.account ? 'client refusé' : stillRefused(c) ? `toujours refusé · compte « ${c.account} »` : `compte « ${c.account} » créé, en attente de connexion`}
                            </span>
                          </td>
                          <td className="td truncate text-xs text-muted" title={`${c.address} · dernière tentative ${new Date(c.lastAt).toLocaleString('fr-FR')}`}>
                            {c.address} · {c.count} tentative{c.count > 1 ? 's' : ''} · {timeAgo(c.lastAt)}
                          </td>
                          <td className="td">
                            <div className="flex justify-end gap-1.5">
                              {!c.account && (
                                <Button size="sm" icon={Plus} disabled={busy} onClick={() => (setClientUser(c.clientId), setClientPassword(''), setForClient(c))}>
                                  Créer
                                </Button>
                              )}
                              <Button size="sm" icon={X} aria-label={`Retirer ${c.clientId} de la liste`} title="Retirer de la liste (revient s'il est de nouveau refusé)" disabled={busy} onClick={() => void forget(c)} />
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    if (r.kind === 'account') {
                      const a = r.a;
                      return (
                        <tr key={a.username}>
                          <td className="td truncate font-mono text-xs text-zinc-100" title={a.username}>
                            {a.username}
                            {a.protected && <span className="ml-2 font-sans text-muted">compte du hub</span>}
                          </td>
                          <td className="td">
                            <Badge tone={a.connected ? 'ok' : 'neutral'}>{a.connected ? (a.connections > 1 ? `connecté · ${a.connections}` : 'connecté') : 'non connecté'}</Badge>
                          </td>
                          <td className="td">
                            {!a.protected && (
                              <div className="flex justify-end gap-1.5">
                                <Button
                                  size="sm"
                                  variant={a.roles.includes('sys-observe') ? 'primary' : 'secondary'}
                                  icon={Activity}
                                  aria-pressed={a.roles.includes('sys-observe')}
                                  aria-label={`Lecture des topics $SYS pour ${a.username}`}
                                  title={a.roles.includes('sys-observe') ? 'Lecture des topics $SYS activée (cliquer pour retirer)' : 'Autoriser la lecture des topics $SYS (uptime, charge du broker…)'}
                                  disabled={busy}
                                  onClick={() => done(() => api.setMqttAccountSys(role.id, a.username, !a.roles.includes('sys-observe')).then(() => undefined))}
                                />
                                <Button size="sm" icon={KeyRound} aria-label={`Changer le mot de passe de ${a.username}`} title="Changer le mot de passe" disabled={busy} onClick={() => (setNewPassword(''), setChanging(a))} />
                                <Button size="sm" variant="danger" icon={Trash2} aria-label={`Supprimer ${a.username}`} title="Supprimer" disabled={busy} onClick={() => setDeleting(a)} />
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    }
                    const c = r.c;
                    return (
                      <tr key={`anonymous:${c.clientId}`} className={anonymousMute ? 'bg-red-500/5' : undefined}>
                        <td className="td truncate font-mono text-xs text-zinc-100" title={c.clientId}>
                          {c.clientId}
                          <span className={clsx('ml-2 font-sans', anonymousMute ? 'text-red-300' : 'text-amber-300')} title={anonymousMute ? 'Le broker accepte la connexion mais refuse ses publications et abonnements (les anonymes n\'ont pas de droits)' : undefined}>
                            {anonymousMute ? 'anonyme refusé · sans droits' : 'anonyme'}
                          </span>
                        </td>
                        <td className="td truncate text-xs text-muted" title={`${c.address} · connecté depuis ${new Date(c.since).toLocaleString('fr-FR')}`}>
                          <Badge tone={anonymousMute ? 'bad' : c.connected ? 'warn' : 'neutral'}>{c.connected ? 'connecté' : 'déconnecté'}</Badge>{' '}
                          {c.address} · {c.connected ? `depuis ${timeAgo(c.since)}` : `vu ${timeAgo(c.lastAt)}`}
                        </td>
                        <td className="td">
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" icon={Plus} disabled={busy} onClick={() => (setClientUser(c.clientId), setClientPassword(''), setForClient({ clientId: c.clientId, address: c.address, count: 0, firstAt: c.since, lastAt: c.lastAt }))}>
                              Créer
                            </Button>
                            <Button size="sm" icon={X} aria-label={`Retirer ${c.clientId} de la liste`} title="Retirer de la liste (revient à sa prochaine connexion)" disabled={busy} onClick={() => void forgetAnonymous(c.clientId)} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {visible.length === 0 && (
                    <tr>
                      <td className="td text-xs text-muted" colSpan={3}>
                        {rows.length ? 'Aucun client pour ce filtre.' : 'Aucun compte ni client.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {pages > 1 && (
                <div className="flex items-center justify-end gap-2 text-xs text-muted">
                  {current * PAGE_SIZE + 1}–{Math.min((current + 1) * PAGE_SIZE, visible.length)} sur {visible.length}
                  <Button size="sm" icon={ChevronLeft} aria-label="Page précédente" disabled={current === 0} onClick={() => setPage(current - 1)} />
                  <Button size="sm" icon={ChevronRight} aria-label="Page suivante" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} />
                </div>
              )}
            </>
          )}
          <form
            className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Nouveau compte</span>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={64} placeholder="esphome, zigbee2mqtt…" autoComplete="off" spellCheck={false} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Mot de passe (généré si vide)</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
            <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={busy || !username.trim()}>
              Ajouter
            </Button>
          </form>
        </div>
      </Modal>

      <Modal
        open={!!forClient}
        onClose={() => setForClient(null)}
        title={`Créer un compte pour ${forClient?.clientId ?? ''}`}
        footer={
          <>
            <Button onClick={() => setForClient(null)}>Annuler</Button>
            <Button variant="primary" icon={Plus} loading={busy} disabled={busy || !clientUser.trim()} onClick={() => void createForClient()}>Créer</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted">
            Le journal du broker donne l'identifiant du client, pas le nom d'utilisateur qu'il a essayé. Saisir le nom que l'appareil utilise (dans sa configuration
            MQTT) : il se connectera dès qu'il aura ce compte et son mot de passe.
          </p>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Nom du compte</span>
            <input className="input" value={clientUser} onChange={(e) => setClientUser(e.target.value)} maxLength={64} autoComplete="off" spellCheck={false} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Mot de passe (généré si vide)</span>
            <input className="input" type="password" value={clientPassword} onChange={(e) => setClientPassword(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
      </Modal>
      <Modal open={!!shown} onClose={() => setShown(null)} title={`Mot de passe de ${shown?.username ?? ''}`} footer={<Button onClick={() => setShown(null)}>Fermer</Button>}>
        <div className="space-y-2 text-sm">
          <p className="text-muted">À copier maintenant et à saisir dans l'appareil : il n'est affiché qu'une fois et ne peut pas être relu ensuite.</p>
          {shown && <CopyField value={shown.password} />}
        </div>
      </Modal>
      <Modal
        open={!!changing}
        onClose={() => setChanging(null)}
        title={`Changer le mot de passe de ${changing?.username ?? ''}`}
        footer={
          <>
            <Button onClick={() => setChanging(null)}>Annuler</Button>
            <Button variant="primary" loading={busy} disabled={busy} onClick={() => void change()}>Changer</Button>
          </>
        }
      >
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted">Nouveau mot de passe (généré si vide)</span>
          <input className="input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <p className="mt-2 text-xs text-muted">L'appareil qui utilise ce compte devra recevoir le nouveau mot de passe.</p>
      </Modal>
      <ConfirmModal open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => void remove()} title="Supprimer le compte" confirmLabel="Supprimer" danger loading={busy}>
        Le compte <b>{deleting?.username}</b> est supprimé du broker : les appareils qui l'utilisent sont refusés à leur prochaine connexion
        {deleting?.connected ? ' (il est connecté en ce moment et sera déconnecté)' : ''}.
      </ConfirmModal>
    </>
  );
}
