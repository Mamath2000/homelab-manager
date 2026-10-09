import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { api, type Account, type Role } from '../lib/api';
import { ROLE_LABELS, useMe } from '../lib/auth';
import { dateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Button, ConfirmModal, Modal, PageHeader, Spinner } from '../components/ui';

const ROLES: { value: Role; hint: string }[] = [
  { value: 'admin', hint: 'tout, y compris les comptes' },
  { value: 'monitor', hint: 'tout sauf les comptes' },
  { value: 'viewer', hint: 'lecture seule, sans paramètres ni comptes' },
];

const ERRORS: Record<string, string> = {
  'username already taken': "Ce nom d'utilisateur est déjà pris",
  'reserved username': "Ce nom d'utilisateur est réservé",
  'cannot demote the last admin': 'Impossible de rétrograder le dernier admin',
  'cannot delete the last admin': 'Impossible de supprimer le dernier admin',
  'cannot delete your own account': 'Impossible de supprimer votre propre compte',
};
const message = (err: unknown) => ERRORS[(err as Error).message] ?? (err as Error).message;

// Create (account = null) or edit an account. New accounts choose their password at the first login.
function AccountModal({ account, open, onClose }: { account: Account | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState(account?.username ?? '');
  const [role, setRole] = useState<Role>(account?.role ?? 'viewer');
  const save = useMutation({
    mutationFn: () =>
      account ? api.updateUser(account.id, { username, role }) : api.createUser(username, role),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      // own username may have changed
      qc.invalidateQueries({ queryKey: ['auth'] });
      toast.success(account ? 'Compte modifié' : `Compte créé : ${username} choisira son mot de passe à la première connexion`);
      onClose();
    },
    onError: (err) => toast.error(message(err)),
  });

  return (
    <Modal open={open} onClose={onClose} title={account ? `Modifier ${account.username}` : 'Nouveau compte'}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Utilisateur</span>
          <input className="input" autoFocus required maxLength={64} value={username} onChange={(e) => setUsername(e.target.value)} />
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
        {!account && <p className="text-xs text-muted">L'utilisateur choisira son mot de passe à sa première connexion (champ mot de passe laissé vide).</p>}
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
  const [resetting, setResetting] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);

  const reset = useMutation({
    mutationFn: (a: Account) => api.resetPassword(a.id),
    onSuccess: (_, a) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(`${a.username} choisira un nouveau mot de passe à sa prochaine connexion`);
      setResetting(null);
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
        actions={!me.isSuperAdmin && <Button icon={Plus} variant="primary" onClick={() => setEditing(null)}>Nouveau compte</Button>}
      />
      {me.isSuperAdmin && (
        <p className="mb-4 text-sm text-muted">Session de secours : vous pouvez uniquement réinitialiser les mots de passe. Elle expire au bout de 15 minutes.</p>
      )}
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line">
              <tr className="text-left">
                <th className="th">Utilisateur</th>
                <th className="th">Rôle</th>
                <th className="th">Mot de passe</th>
                <th className="th">Créé le</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((a) => (
                <tr key={a.id} className="border-b border-line/60 last:border-0">
                  <td className="td font-medium text-zinc-100">
                    {a.username}
                    {a.username === me.username && <span className="ml-2 text-xs text-muted">(vous)</span>}
                  </td>
                  <td className="td"><Badge tone={a.role === 'admin' ? 'warn' : a.role === 'monitor' ? 'info' : 'neutral'}>{ROLE_LABELS[a.role]}</Badge></td>
                  <td className="td text-xs">{a.passwordPending ? <span className="text-amber-300">à définir à la prochaine connexion</span> : <span className="text-zinc-400">défini</span>}</td>
                  <td className="td text-xs text-zinc-400">{dateTime(a.createdAt)}</td>
                  <td className="td">
                    <div className="flex justify-end gap-1">
                      {!me.isSuperAdmin && <Button size="sm" variant="ghost" icon={Pencil} title="Modifier" onClick={() => setEditing(a)} />}
                      <Button size="sm" variant="ghost" icon={KeyRound} title="Réinitialiser le mot de passe" onClick={() => setResetting(a)} />
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

      {editing !== undefined && <AccountModal key={editing?.id ?? 'new'} account={editing} open onClose={() => setEditing(undefined)} />}
      <ConfirmModal
        open={!!resetting}
        onClose={() => setResetting(null)}
        onConfirm={() => resetting && reset.mutate(resetting)}
        title="Réinitialiser le mot de passe"
        confirmLabel="Réinitialiser"
        danger
        loading={reset.isPending}
      >
        Le mot de passe de <strong>{resetting?.username}</strong> sera effacé et ses sessions fermées. À sa prochaine connexion, il
        saisira son nom d'utilisateur sans mot de passe puis en choisira un nouveau.
      </ConfirmModal>
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
