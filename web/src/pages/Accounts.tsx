import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { api, type Account, type AccountWithPassword, type Role } from '../lib/api';
import { ROLE_LABELS, useMe } from '../lib/auth';
import { dateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Button, ConfirmModal, CopyField, Modal, PageHeader, Spinner } from '../components/ui';

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

// Create (account = null) or edit an account. New accounts get a temporary password.
function AccountModal({ account, open, onClose, onCreated }: {
  account: Account | null;
  open: boolean;
  onClose: () => void;
  onCreated: (r: AccountWithPassword) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState(account?.username ?? '');
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [role, setRole] = useState<Role>(account?.role ?? 'viewer');
  const save = useMutation({
    mutationFn: async () =>
      account
        ? (await api.updateUser(account.id, { username, displayName, role }), null)
        : api.createUser(username, displayName, role),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      // own username / name may have changed
      if (account) qc.invalidateQueries({ queryKey: ['auth'] });
      toast.success(account ? 'Compte modifié' : `Compte ${username} créé : mot de passe temporaire dans le tableau`);
      onClose();
      if (created) onCreated(created);
    },
    onError: (err) => toast.error(message(err)),
  });

  return (
    <Modal open={open} onClose={onClose} title={account ? `Modifier ${account.displayName || account.username}` : 'Nouveau compte'}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Nom (facultatif)</span>
          <input className="input" autoFocus maxLength={64} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Prénom Nom" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Identifiant de connexion</span>
          <input className="input" required maxLength={64} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-medium text-muted">Rôle</legend>
          {ROLES.map((r) => (
            <label key={r.value} className="flex cursor-pointer items-center gap-2.5 text-sm text-zinc-200">
              <input type="radio" name="role" checked={role === r.value} onChange={() => setRole(r.value)} />
              {ROLE_LABELS[r.value]}
              <span className="text-xs text-muted">— {r.hint}</span>
            </label>
          ))}
        </fieldset>
        {!account && <p className="text-xs text-muted">Un mot de passe temporaire sera généré ; l'utilisateur le remplacera à sa première connexion.</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{account ? 'Enregistrer' : 'Créer'}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function Accounts() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: api.users });
  // undefined: closed, null: creating
  const [editing, setEditing] = useState<Account | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Account | null>(null);
  // temporary passwords to hand over, shown in their row until hidden (account id -> password)
  const [issued, setIssued] = useState<Record<string, string>>({});
  // row whose reset waits for confirmation
  const [confirming, setConfirming] = useState<string | null>(null);

  const showIssued = (r: AccountWithPassword) => setIssued((m) => ({ ...m, [r.user.id]: r.temporaryPassword }));
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
      <PageHeader
        icon={Users}
        title="Comptes"
        actions={<Button icon={Plus} variant="primary" onClick={() => setEditing(null)}>Nouveau compte</Button>}
      />
      {me.isSuperAdmin && (
        <p className="mb-4 text-sm text-muted">
          Session <strong className="text-zinc-300">superadmin</strong> : vous pouvez créer des comptes et réinitialiser leurs mots de passe.
          Elle expire au bout de 15 minutes ; déconnectez-vous ensuite et connectez-vous avec un compte admin.
        </p>
      )}
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line">
              <tr className="text-left">
                <th className="th">Compte</th>
                <th className="th">Rôle</th>
                <th className="th">Mot de passe</th>
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
                  <td className="td text-xs text-zinc-400">{a.lastLoginAt ? dateTime(a.lastLoginAt) : 'jamais'}</td>
                  <td className="td text-xs text-zinc-400">{dateTime(a.createdAt)}</td>
                  <td className="td">
                    <div className="flex justify-end gap-1">
                      {!me.isSuperAdmin && <Button size="sm" variant="ghost" icon={Pencil} title="Modifier" onClick={() => setEditing(a)} />}
                      {!me.isSuperAdmin && a.username !== me.username && (
                        <Button size="sm" variant="ghost" icon={Trash2} title="Supprimer" onClick={() => setDeleting(a)} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing !== undefined && (
        <AccountModal key={editing?.id ?? 'new'} account={editing} open onClose={() => setEditing(undefined)} onCreated={showIssued} />
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
        Supprimer définitivement le compte <strong>{deleting?.username}</strong> ?
      </ConfirmModal>
    </>
  );
}
