import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { ConfirmModal, Spinner } from './ui';

// New secret for the PBS token of every host at once (hub routes/backupJobs.ts, #205): same ids, the old
// secrets revoked at once, so the hosts offline are skipped. The confirmation previews the targets.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

export function PbsRotateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { data: preview } = useQuery({ queryKey: ['settings', 'pbs', 'rotate'], queryFn: api.pbsRotatePreview, enabled: open, staleTime: 0 });
  const online = preview?.hosts.filter((h) => h.online) ?? [];
  const offline = preview?.hosts.filter((h) => !h.online) ?? [];

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.rotatePbsCredentials();
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
        <p>Aucun hôte n’a de jeton PBS.</p>
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
        </div>
      )}
    </ConfirmModal>
  );
}
