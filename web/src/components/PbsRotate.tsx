import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { ConfirmModal, Spinner } from './ui';

// New secret for the PBS tokens of several hosts at once (hub routes/backupJobs.ts, #205): every host holding
// one, or a selection of the list of the hosts (hostIds). Same ids, the old secrets revoked at once, so the
// hosts offline are skipped. The confirmation previews the targets.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

export function PbsRotateModal({ open, onClose, hostIds }: { open: boolean; onClose: () => void; hostIds?: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { data: preview } = useQuery({ queryKey: ['settings', 'pbs', 'rotate', hostIds ?? null], queryFn: () => api.pbsRotatePreview(hostIds), enabled: open, staleTime: 0 });
  // hosts of the selection without a token: not concerned
  const without = hostIds && preview ? hostIds.length - preview.hosts.length : 0;
  const online = preview?.hosts.filter((h) => h.online) ?? [];
  const offline = preview?.hosts.filter((h) => !h.online) ?? [];

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.rotatePbsCredentials(hostIds);
      toast.success(`${plural(r.rotated.length, 'jeton régénéré', 'jetons régénérés')}${r.skipped.length ? `, ${plural(r.skipped.length, 'hôte hors ligne ignoré', 'hôtes hors ligne ignorés')}` : ''}`);
      if (r.errors.length) toast.error(`Non régénérés : ${r.errors.map((e) => `${e.name} (${e.error})`).join(' ; ')}`);
      qc.invalidateQueries({ queryKey: ['backup-jobs'] });
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmModal
      open={open}
      onClose={() => !busy && onClose()}
      onConfirm={() => void run()}
      title="Régénérer les jetons des hôtes ?"
      confirmLabel="Régénérer"
      loading={busy}
      disabled={!online.length}
    >
      {!preview ? (
        <div className="flex justify-center p-4"><Spinner /></div>
      ) : !preview.hosts.length ? (
        <p>{hostIds ? 'Aucun hôte sélectionné n’a de jeton PBS.' : 'Aucun hôte n’a de jeton PBS.'}</p>
      ) : (
        <div className="space-y-3">
          <p>
            Chaque jeton reçoit un nouveau secret sous le même identifiant (les groupes restent les siens) : l’ancien est révoqué aussitôt et le nouveau transmis à
            l’agent de l’hôte.
          </p>
          {online.length > 0 && (
            <div>
              <p className="text-xs font-medium text-zinc-100">{plural(online.length, 'jeton régénéré', 'jetons régénérés')}</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                {online.map((h) => (
                  <li key={h.id}>{h.name} · <code>{h.tokenId}</code></li>
                ))}
              </ul>
            </div>
          )}
          {offline.length > 0 && (
            <div>
              <p className="text-xs font-medium text-amber-400">{plural(offline.length, 'hôte hors ligne ignoré', 'hôtes hors ligne ignorés')} (leur jeton reste valide)</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                {offline.map((h) => (
                  <li key={h.id}>{h.name} · <code>{h.tokenId}</code></li>
                ))}
              </ul>
            </div>
          )}
          {without > 0 && <p className="text-xs text-muted">{plural(without, 'hôte sélectionné', 'hôtes sélectionnés')} sans jeton PBS : non concerné{without > 1 && 's'}.</p>}
        </div>
      )}
    </ConfirmModal>
  );
}
