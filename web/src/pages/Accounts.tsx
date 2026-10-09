import { useState } from 'react';
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

// Temporary password of a new or reset account, shown only once.
function TemporaryPasswordModal({ result, onClose }: { result: AccountWithPassword | null; onClose: () => void }) {
  return (
    <Modal open={!!result} onClose={onClose} title={`Mot de passe temporaire de ${result?.user.username}`}>
      <div className="space-y-3 text-sm">
        <p className="text-zinc-300">À transmettre à l'utilisateur : il devra le remplacer à sa première connexion.</p>
        {result && <CopyField value={result.temporaryPassword} />}
        <p className="text-xs text-amber-300">Il ne sera plus affiché.</p>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>J'ai noté le mot de passe</Button>
        </div>
      </div>
    </Modal>
  );
}

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
  const [role, setRole] = useState<Role>(account?.role ?? 'viewer');
  const save = useMutation({
    mutationFn: async () => (account ? (await api.updateUser(account.id, { username, role }), null) : api.createUser(username, role)),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      // own username may have changed
      if (account) qc.invalidateQueries({ queryKey: ['auth'] });
      toast.success(account ? 'Compte modifié' : `Compte ${username} créé`);
      onClose();
      if (created) onCreated(created);
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
  const [resetting, setResetting] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [issued, setIssued] = useState<AccountWithPassword | null>(null);

  const reset = useMutation({
    mutationFn: (a: Account) => api.resetPassword(a.id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setResetting(null);
      setIssued(r);
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
                <th className="th">Utilisateur</th>
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
                  <td className="td font-medium text-zinc-100">
                    {a.username}
                    {a.username === me.username && <span className="ml-2 text-xs text-muted">(vous)</span>}
                  </td>
                  <td className="td"><Badge tone={a.role === 'admin' ? 'warn' : a.role === 'operator' ? 'info' : 'neutral'}>{ROLE_LABELS[a.role]}</Badge></td>
                  <td className="td text-xs">{a.mustChangePassword ? <span className="text-amber-300">temporaire, à changer à la connexion</span> : <span className="text-zinc-400">défini</span>}</td>
                  <td className="td text-xs text-zinc-400">{a.lastLoginAt ? dateTime(a.lastLoginAt) : 'jamais'}</td>
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

      {editing !== undefined && (
        <AccountModal key={editing?.id ?? 'new'} account={editing} open onClose={() => setEditing(undefined)} onCreated={setIssued} />
      )}
      <TemporaryPasswordModal result={issued} onClose={() => setIssued(null)} />
      <ConfirmModal
        open={!!resetting}
        onClose={() => setResetting(null)}
        onConfirm={() => resetting && reset.mutate(resetting)}
        title="Réinitialiser le mot de passe"
        confirmLabel="Réinitialiser"
        danger
        loading={reset.isPending}
      >
        Un nouveau mot de passe temporaire sera généré pour <strong>{resetting?.username}</strong> et ses sessions seront fermées.
        Il devra le remplacer à sa prochaine connexion.
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
