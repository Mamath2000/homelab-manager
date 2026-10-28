import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DisconnectReport, type PbsRemoteSettings } from '../lib/api';
import { useToast } from '../lib/toast';
import { ConfirmModal, Spinner } from './ui';

// Disconnection of the main PBS (and of the secondary with it) or of the secondary alone (hub
// disconnect.ts): the confirmation lists what goes; the snapshots never do.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

function reportSummary(r: DisconnectReport) {
  const parts = [
    r.revoked.length && plural(r.revoked.length, 'jeton révoqué', 'jetons révoqués'),
    r.syncJobs && plural(r.syncJobs, 'sync job retiré', 'sync jobs retirés'),
    r.cachedJobs && plural(r.cachedJobs, 'job mis de côté', 'jobs mis de côté'),
    r.groups && plural(r.groups, 'groupe oublié', 'groupes oubliés'),
  ].filter(Boolean);
  return parts.length ? `Déconnecté : ${parts.join(', ')}` : 'Déconnecté';
}

const Token = ({ id }: { id: string | null }) => (id ? <code>{id}</code> : null);

export function PbsDisconnectModal({ open, onClose, remote }: { open: boolean; onClose: () => void; remote?: PbsRemoteSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const main = !remote;
  const { data: preview } = useQuery({ queryKey: ['settings', 'pbs', 'disconnect'], queryFn: api.pbsDisconnectPreview, enabled: open && main, staleTime: 0 });
  const r = main ? preview?.remote : remote ? { host: remote.url ? new URL(remote.url).hostname : null, tokenId: remote.tokenId || null, readerTokenId: remote.readerTokenId || null } : null;

  const run = async () => {
    setBusy(true);
    try {
      const report = main ? await api.disconnectPbs() : await api.disconnectPbsRemote();
      toast.success(reportSummary(report));
      if (report.errors.length) toast.error(`À terminer à la main : ${report.errors.join(' ; ')}`);
      for (const key of [['settings'], ['backups'], ['backup-jobs']]) qc.invalidateQueries({ queryKey: key });
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
      title={main ? 'Déconnecter le PBS principal ?' : 'Déconnecter le PBS de secours ?'}
      confirmLabel="Déconnecter"
      loading={busy}
      danger
    >
      {main && !preview ? (
        <div className="flex justify-center p-4"><Spinner /></div>
      ) : (
        <div className="space-y-3">
          <p>Homelab Manager retire ce qu’il a créé sur les PBS et revient à un état sans {main ? 'PBS' : 'PBS de secours'}. Aucun snapshot n’est supprimé.</p>
          <ul className="list-disc space-y-1.5 pl-5 text-xs text-muted">
            {r && (
              <li>
                <b className="text-zinc-300">PBS de secours{r.host ? ` (${r.host})` : ''}</b> : la série quotidienne s’arrête, les sync jobs <code>hlm-*</code> et la remote{' '}
                <code>hlm-main</code> sont retirés, jetons <Token id={r.tokenId} /> {r.tokenId && r.readerTokenId && 'et '}
                <Token id={r.readerTokenId} /> révoqués. Les copies restent.
              </li>
            )}
            {main && preview && (
              <>
                {preview.hosts.length > 0 && (
                  <li>
                    <b className="text-zinc-300">{plural(preview.hosts.length, 'hôte')}</b> : les agents arrêtent leurs sauvegardes, leurs jetons sont révoqués ; les jobs saisis à la main
                    et les réglages du plugin Nextcloud sont mis de côté, proposés à la reconnexion.
                    <ul className="mt-1 list-[circle] pl-5">
                      {preview.hosts.map((h) => (
                        <li key={h.name}>
                          {h.name} : {plural(h.jobs, 'job')}
                          {h.nextcloud && ', plugin Nextcloud'}
                          {h.tokenId && <> · <code>{h.tokenId}</code></>}
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
                <li>
                  <b className="text-zinc-300">PBS principal</b> : jeton <Token id={preview.monitorToken} /> révoqué, {plural(preview.groups, 'groupe relevé', 'groupes relevés')} oublié
                  {preview.groups > 1 && 's'} par Homelab Manager (ils restent sur le PBS). Les sauvegardes Home Assistant restent suivies.
                </li>
              </>
            )}
          </ul>
        </div>
      )}
    </ConfirmModal>
  );
}
