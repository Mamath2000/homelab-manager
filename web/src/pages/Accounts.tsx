import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Trash2, TriangleAlert, Users } from 'lucide-react';
import { api, type Account, type AccountSecret, type ApiKey, type Role } from '../lib/api';
import { ROLE_LABELS, useMe } from '../lib/auth';
import { dateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { HeaderTitle } from '../components/HeaderSlot';
import { Badge, Button, ConfirmModal, CopyField, Modal, ResponsiveList, Spinner } from '../components/ui';

const ROLES: { value: Role; hint: string }[] = [
  { value: 'admin', hint: 'tout : hôtes, paramètres, comptes' },
  { value: 'operator', hint: 'lance les vérifications, mises à jour, nettoyages et redémarrages' },
  { value: 'viewer', hint: 'lecture seule' },
];

const ERRORS: Record<string, string> = {
  'username already taken': "Ce nom d'utilisateur est déjà pris",
  'reserved username': "Ce nom d'utilisateur est réservé",
  'cannot demote the last admin': 'Impossible de rétrograder le dernier admin',
  'cannot delete the last admin': 'Impossible de supprimer le dernier admin',
  'cannot delete your own account': 'Impossible de supprimer votre propre compte',
};
const message = (err: unknown) => ERRORS[(err as Error).message] ?? (err as Error).message;

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function RolePicker({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {ROLES.map((r) => (
        <label
          key={r.value}
          className={`cursor-pointer rounded-md border p-3 text-sm transition-colors ${value === r.value ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-line hover:border-zinc-600'}`}
        >
          <input type="radio" name="role" className="sr-only" checked={value === r.value} onChange={() => onChange(r.value)} />
          <div className="font-medium text-zinc-100">{ROLE_LABELS[r.value]}</div>
          <div className="mt-0.5 text-xs text-muted">{r.hint}</div>
        </label>
      ))}
    </div>
  );
}

// API keys of an account: one per consumer (Homepage, a script…), each revoked on its own.
// They carry the rights of the account's role. A new key is shown once, here.
function ApiKeysSection({ account }: { account: Account }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ name: string; value: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const create = useMutation({
    mutationFn: () => api.createApiKey(account.id, name.trim()),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setIssued({ name: name.trim(), value: r.apiKey! });
      setName('');
    },
    onError: (err) => toast.error(message(err)),
  });
  const revoke = useMutation({
    mutationFn: (k: ApiKey) => api.revokeApiKey(account.id, k.id),
    onSuccess: (_, k) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(`Clé « ${k.name} » révoquée`);
      setRevoking(null);
    },
    onError: (err) => toast.error(message(err)),
  });

  return (
    <Section
      title="Clés d'API"
      hint="Accès sans mot de passe, en-tête « Authorization: Bearer <clé> », avec les droits du rôle. Une clé par service."
    >
      {issued && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <div className="text-sm text-zinc-200">Clé « {issued.name} » créée</div>
          <CopyField value={issued.value} />
          <p className="text-xs text-amber-300">
            Affichée une seule fois, copiez-la maintenant.{' '}
            <button type="button" className="text-muted underline hover:text-zinc-200" onClick={() => setIssued(null)}>Masquer</button>
          </p>
        </div>
      )}
      {account.apiKeys.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-line">
          <ResponsiveList mode="mobile">
            {account.apiKeys.map((k) => (
              <article key={k.id} className="space-y-2 p-4">
                <div className="font-medium text-zinc-100">{k.name}</div>
                <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400">
                  <div><span className="text-muted">Créée le · </span>{dateTime(k.createdAt)}</div>
                  <div><span className="text-muted">Dernière utilisation · </span>{k.lastUsedAt ? dateTime(k.lastUsedAt) : 'jamais'}</div>
                </div>
                <Button size="sm" variant="ghost" icon={Trash2} className="min-h-10 md:min-h-0" title="Révoquer cette clé" onClick={() => setRevoking(k)}>Révoquer</Button>
              </article>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-white/[0.02]">
              <tr className="text-left">
                <th className="th">Nom</th>
                <th className="th">Créée le</th>
                <th className="th">Dernière utilisation</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {account.apiKeys.map((k) => (
                <tr key={k.id} className="border-b border-line/60 last:border-0">
                  <td className="td font-medium text-zinc-100">{k.name}</td>
                  <td className="td text-xs text-zinc-400">{dateTime(k.createdAt)}</td>
                  <td className="td text-xs text-zinc-400">{k.lastUsedAt ? dateTime(k.lastUsedAt) : 'jamais'}</td>
                  <td className="td text-right">
                    <Button size="sm" variant="ghost" icon={Trash2} title="Révoquer cette clé" onClick={() => setRevoking(k)}>Révoquer</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </ResponsiveList>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-muted">Aucune clé d'API.</p>
      )}
      <div className="flex items-end gap-2">
        <label className="block flex-1">
          <span className="mb-1.5 block text-xs font-medium text-muted">Nouvelle clé</span>
          <input
            className="input"
            maxLength={64}
            value={name}
            placeholder="Nom du service (Homepage, script de sauvegarde…)"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (name.trim()) create.mutate();
              }
            }}
          />
        </label>
        <Button type="button" icon={KeyRound} loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Générer</Button>
      </div>
      <ConfirmModal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        title="Révoquer la clé d'API"
        confirmLabel="Révoquer"
        danger
        loading={revoke.isPending}
      >
        Révoquer la clé <strong>{revoking?.name}</strong> ? Le service qui l'utilise sera refusé immédiatement.
      </ConfirmModal>
    </Section>
  );
}

// Create (accountId = null) or edit an account. Keys are managed when editing only.
function AccountModal({ accountId, onClose, onCreated }: {
  accountId: string | null;
  onClose: () => void;
  onCreated: (r: AccountSecret) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['users'], queryFn: api.users });
  const account = accountId ? data?.find((a) => a.id === accountId) ?? null : null;
  const [username, setUsername] = useState(account?.username ?? '');
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [role, setRole] = useState<Role>(account?.role ?? 'viewer');
  const [noPassword, setNoPassword] = useState(false);
  const save = useMutation({
    mutationFn: async () =>
      account
        ? (await api.updateUser(account.id, { username, displayName, role }), null)
        : api.createUser(username, displayName, role, noPassword),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      // own username / name may have changed
      if (account) qc.invalidateQueries({ queryKey: ['auth'] });
      toast.success(
        account ? 'Compte modifié' : noPassword ? `Compte ${username} créé : ajoutez-lui une clé d'API en le modifiant` : `Compte ${username} créé : mot de passe temporaire dans le tableau`,
      );
      onClose();
      if (created?.temporaryPassword) onCreated(created);
    },
    onError: (err) => toast.error(message(err)),
  });

  const editing = !!account;
  return (
    <Modal
      open
      wide
      scroll
      onClose={onClose}
      title={editing ? `Modifier ${account.displayName || account.username}` : 'Nouveau compte'}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{editing ? 'Fermer' : 'Annuler'}</Button>
          <Button type="submit" form="account-form" variant="primary" loading={save.isPending}>{editing ? 'Enregistrer' : 'Créer'}</Button>
        </div>
      }
    >
      <div className="space-y-6">
        <form id="account-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-6">
          <Section title="Identité">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Nom (facultatif)</span>
                <input className="input" autoFocus maxLength={64} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Prénom Nom" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Identifiant de connexion</span>
                <input className="input" required maxLength={64} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
              </label>
            </div>
          </Section>
          <Section title="Rôle">
            <RolePicker value={role} onChange={setRole} />
          </Section>
          {!editing && (
            <Section title="Mot de passe">
              <div className="space-y-2">
                <label className="flex cursor-pointer items-start gap-2.5 text-sm text-zinc-200">
                  <input type="radio" name="password" className="mt-1 accent-emerald-500" checked={!noPassword} onChange={() => setNoPassword(false)} />
                  <span>
                    Mot de passe temporaire
                    <span className="block text-xs text-muted">Généré et affiché une fois ; l'utilisateur le remplace à sa première connexion.</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 text-sm text-zinc-200">
                  <input type="radio" name="password" className="mt-1 accent-emerald-500" checked={noPassword} onChange={() => setNoPassword(true)} />
                  <span>
                    Aucun mot de passe
                    <span className="block text-xs text-muted">Compte réservé aux services : accès par clé d'API, à ajouter ensuite en modifiant le compte.</span>
                  </span>
                </label>
              </div>
              {noPassword && (
                <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-300">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  Cet utilisateur ne pourra pas se connecter à l'interface.
                </p>
              )}
            </Section>
          )}
        </form>
        {account && <ApiKeysSection account={account} />}
      </div>
    </Modal>
  );
}

export function Accounts() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: api.users });
  // undefined: closed, null: creating
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Account | null>(null);
  // temporary passwords to hand over, shown in their row until hidden (account id -> password)
  const [issued, setIssued] = useState<Record<string, string>>({});
  // row whose reset waits for confirmation
  const [confirming, setConfirming] = useState<string | null>(null);

  const showIssued = (r: AccountSecret) => setIssued((m) => ({ ...m, [r.user.id]: r.temporaryPassword! }));
  const hideIssued = (id: string) =>
    setIssued((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });

  // an unconfirmed reset is dropped after a few seconds
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 5000);
    return () => clearTimeout(t);
  }, [confirming]);

  const reset = useMutation({
    mutationFn: (a: Account) => api.resetPassword(a.id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setConfirming(null);
      showIssued(r);
    },
    onError: (err) => toast.error(message(err)),
  });
  const remove = useMutation({
    mutationFn: (a: Account) => api.deleteUser(a.id),
    onSuccess: (_, a) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(`Compte ${a.username} supprimé`);
      setDeleting(null);
    },
    onError: (err) => toast.error(message(err)),
  });

  return (
    <>
      <HeaderTitle icon={Users} title="Comptes" />
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} variant="primary" onClick={() => setEditing(null)}>Nouveau compte</Button>
      </div>
      {me.isSuperAdmin && (
        <p className="mb-4 text-sm text-muted">
          Session <strong className="text-zinc-300">superadmin</strong> : vous pouvez créer des comptes et réinitialiser leurs mots de passe.
          Elle expire au bout de 15 minutes ; déconnectez-vous ensuite et connectez-vous avec un compte admin.
        </p>
      )}
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="panel min-w-0">
          <ResponsiveList mode="mobile">
            {data?.map((a) => (
              <article key={a.id} className="min-w-0 space-y-3 p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="break-words font-medium text-zinc-100">
                      {a.displayName || a.username}
                      {a.username === me.username && <span className="ml-2 text-xs font-normal text-muted">(vous)</span>}
                    </div>
                    {a.displayName && <div className="break-all font-mono text-xs text-muted">{a.username}</div>}
                  </div>
                  <Badge tone={a.role === 'admin' ? 'warn' : a.role === 'operator' ? 'info' : 'neutral'}>{ROLE_LABELS[a.role]}</Badge>
                </div>
                <div className="space-y-2 text-xs">
                  <div>
                    <div className="text-muted">Mot de passe</div>
                    {issued[a.id] ? (
                      <div className="mt-1 space-y-1.5">
                        <CopyField value={issued[a.id]} />
                        <p className="text-amber-300">
                          Affiché une seule fois.{' '}
                          <button className="text-muted underline hover:text-zinc-200" onClick={() => hideIssued(a.id)}>Masquer</button>
                        </p>
                      </div>
                    ) : !a.hasPassword ? (
                      <span className="text-zinc-400">aucun · connexion impossible</span>
                    ) : confirming === a.id ? (
                      <div className="mt-1 flex flex-wrap gap-2">
                        <Button size="sm" variant="danger" icon={KeyRound} className="min-h-10 md:min-h-0" loading={reset.isPending} onClick={() => reset.mutate(a)}>
                          Confirmer la réinitialisation
                        </Button>
                        <Button size="sm" variant="ghost" className="min-h-10 md:min-h-0" onClick={() => setConfirming(null)}>Annuler</Button>
                      </div>
                    ) : (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className={a.mustChangePassword ? 'text-amber-300' : 'text-zinc-400'}>
                          {a.mustChangePassword ? 'temporaire, à changer à la connexion' : 'défini'}
                        </span>
                        {a.username !== me.username && (
                          <Button size="sm" variant="ghost" icon={KeyRound} className="min-h-10 md:min-h-0" title="Génère un mot de passe temporaire et ferme les sessions du compte" onClick={() => setConfirming(a.id)}>
                            Réinitialiser
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-zinc-400">
                    <div><span className="text-muted">Clés d’API · </span>{a.apiKeys.length ? `${a.apiKeys.length} clé${a.apiKeys.length > 1 ? 's' : ''}` : '—'}</div>
                    <div><span className="text-muted">Dernière connexion · </span>{a.lastLoginAt ? dateTime(a.lastLoginAt) : 'jamais'}</div>
                    <div><span className="text-muted">Créé le · </span>{dateTime(a.createdAt)}</div>
                  </div>
                </div>
                {!me.isSuperAdmin && (
                  <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                    <Button size="sm" variant="ghost" icon={Pencil} className="min-h-10 md:min-h-0" onClick={() => setEditing(a.id)}>Modifier</Button>
                    {a.username !== me.username && (
                      <Button size="sm" variant="ghost" icon={Trash2} className="min-h-10 md:min-h-0" onClick={() => setDeleting(a)}>Supprimer</Button>
                    )}
                  </div>
                )}
              </article>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
          <table className="w-full text-sm">
            <thead className="border-b border-line">
              <tr className="text-left">
                <th className="th">Compte</th>
                <th className="th">Rôle</th>
                <th className="th">Mot de passe</th>
                <th className="th">Clés d'API</th>
                <th className="th">Dernière connexion</th>
                <th className="th">Créé le</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((a) => (
                <tr key={a.id} className="border-b border-line/60 last:border-0">
                  <td className="td">
                    <div className="font-medium text-zinc-100">
                      {a.displayName || a.username}
                      {a.username === me.username && <span className="ml-2 text-xs font-normal text-muted">(vous)</span>}
                    </div>
                    {a.displayName && <div className="font-mono text-xs text-muted">{a.username}</div>}
                  </td>
                  <td className="td"><Badge tone={a.role === 'admin' ? 'warn' : a.role === 'operator' ? 'info' : 'neutral'}>{ROLE_LABELS[a.role]}</Badge></td>
                  <td className="td text-xs">
                    {issued[a.id] ? (
                      <div className="max-w-xs space-y-1.5">
                        <CopyField value={issued[a.id]} />
                        <p className="text-amber-300">
                          Affiché une seule fois, à transmettre.{' '}
                          <button className="text-muted underline hover:text-zinc-200" onClick={() => hideIssued(a.id)}>Masquer</button>
                        </p>
                      </div>
                    ) : !a.hasPassword ? (
                      <span className="text-zinc-400">aucun · connexion impossible</span>
                    ) : confirming === a.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="danger" icon={KeyRound} loading={reset.isPending} onClick={() => reset.mutate(a)}>
                          Confirmer la réinitialisation
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Annuler</Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        {a.mustChangePassword ? <span className="text-amber-300">temporaire, à changer à la connexion</span> : <span className="text-zinc-400">défini</span>}
                        {/* own password: changed from the key icon of the header */}
                        {a.username !== me.username && (
                          <Button size="sm" variant="ghost" icon={KeyRound} title="Génère un mot de passe temporaire et ferme les sessions du compte" onClick={() => setConfirming(a.id)}>
                            Réinitialiser
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="td text-xs text-zinc-400">{a.apiKeys.length ? `${a.apiKeys.length} clé${a.apiKeys.length > 1 ? 's' : ''}` : '—'}</td>
                  <td className="td text-xs text-zinc-400">{a.lastLoginAt ? dateTime(a.lastLoginAt) : 'jamais'}</td>
                  <td className="td text-xs text-zinc-400">{dateTime(a.createdAt)}</td>
                  <td className="td">
                    <div className="flex justify-end gap-1">
                      {!me.isSuperAdmin && <Button size="sm" variant="ghost" icon={Pencil} title="Modifier" onClick={() => setEditing(a.id)} />}
                      {!me.isSuperAdmin && a.username !== me.username && (
                        <Button size="sm" variant="ghost" icon={Trash2} title="Supprimer" onClick={() => setDeleting(a)} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </ResponsiveList>
        </div>
      )}

      {editing !== undefined && (
        <AccountModal key={editing ?? 'new'} accountId={editing} onClose={() => setEditing(undefined)} onCreated={showIssued} />
      )}
      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
        title="Supprimer le compte"
        confirmLabel="Supprimer"
        danger
        loading={remove.isPending}
      >
        Supprimer définitivement le compte <strong>{deleting?.username}</strong>{deleting?.apiKeys.length ? ` et ses ${deleting.apiKeys.length} clé(s) d'API` : ''} ?
      </ConfirmModal>
    </>
  );
}
