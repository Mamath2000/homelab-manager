import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Play, Save } from 'lucide-react';
import { api, type VpnProbeDetail } from '../lib/api';
import { stepStates } from '../lib/steps';
import { useToast } from '../lib/toast';
import { CheckLine, Step, Steps, type CheckState } from './PbsDialog';
import { OptionList } from './OptionList';
import { Badge, Button, ConfirmModal, Modal, Spinner, StatusDot } from './ui';

// The source and the target of the probe of a site-to-site VPN (homelab#261): a host of the networks the tunnel carries on
// this side pings a machine of the networks on the other side. Only the hosts and equipments whose address is in those
// networks are offered (the site of a host in the hub says nothing of its network).

function Body({ d, onClose }: { d: VpnProbeDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const initial = { sourceHostId: d.probe.sourceHostId, host: d.probe.host };
  const [sel, setSel] = useState(initial);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<CheckState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const set = (patch: Partial<typeof sel>) => {
    setSel({ ...sel, ...patch });
    setTest(null);
  };
  const dirty = sel.sourceHostId !== initial.sourceHostId || sel.host !== initial.host;
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const source = d.sources.find((s) => s.id === sel.sourceHostId);
  const sourceKnown = !sel.sourceHostId || !!source;
  const targetKnown = !sel.host || d.targets.some((t) => t.ip === sel.host);

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      const m = await api.testVpnProbe(d.probe.id, sel);
      setTest(
        m.state === 'up'
          ? { level: 'ok', title: 'Le trafic passe', detail: m.latencyMs ? `répond en ${m.latencyMs} ms` : undefined }
          : m.state === 'down'
            ? { level: 'error', title: 'down', detail: m.message }
            : { level: 'warn', title: 'Mesure impossible', detail: m.message },
      );
    } catch (err) {
      setTest({ level: 'error', title: 'Échec du test', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      await api.setVpnProbe(d.probe.id, sel);
      await Promise.all([qc.invalidateQueries({ queryKey: ['probes'] }), qc.invalidateQueries({ queryKey: ['settings', 'omada'] })]);
      toast.success(`Sonde ${d.probe.name} enregistrée`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const v = d.vpn;
  const [tunnelState, sourceState, targetState, testState] = stepStates([true, !!sel.sourceHostId && sourceKnown, !!sel.host && targetKnown, test?.level === 'ok']);
  return (
    <>
      <Modal
        open
        onClose={requestClose}
        wide="screen"
        wider
        fixed
        title={`Sonde du tunnel ${v.name}`}
        footer={
          <>
            <Button disabled={busy !== null} onClick={requestClose}>Annuler</Button>
            <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={busy !== null || !dirty || !sourceKnown || !targetKnown} onClick={() => void save()}>
              Enregistrer
            </Button>
          </>
        }
      >
        <Steps fill>
          <Step n={1} title="Tunnel" state={tunnelState} intro="Ce que la sonde éprouve : le trafic entre les réseaux des deux côtés.">
            <p className="flex items-center gap-2 text-zinc-100">
              <StatusDot tone={!v.enabled ? 'neutral' : v.established ? 'ok' : 'bad'} />
              {v.name}
              {!v.enabled && <Badge tone="neutral">désactivé : sonde en pause</Badge>}
            </p>
            <p className="text-xs text-muted">{v.enabled ? (v.established ? 'Établi selon Omada (associations de sécurité en entrée et en sortie).' : 'Non établi selon Omada.') : 'Désactivé dans Omada.'}</p>
            <div className="space-y-1 font-mono text-xs text-zinc-300">
              <p><span className="text-muted">Local : </span>{v.localSubnets.join(', ') || '—'}</p>
              <p className="flex items-center gap-1 text-muted"><ArrowRight className="h-3.5 w-3.5" /> {v.remoteIp ?? ''}</p>
              <p><span className="text-muted">Distant : </span>{v.remoteSubnets.join(', ')}</p>
            </div>
          </Step>
          <Step n={2} title="Source" state={sourceState} intro="L'hôte qui pingue, par son agent, depuis son adresse dans les réseaux locaux.">
            <OptionList
              label="Hôte source"
              value={sel.sourceHostId}
              onChange={(x) => set({ sourceHostId: x })}
              search
              items={[
                ...(!sourceKnown ? [{ value: sel.sourceHostId, label: 'Source hors des réseaux du tunnel', detail: 'À choisir', warn: true }] : []),
                ...d.sources.map((s) => ({ value: s.id, label: s.name, detail: s.ip })),
              ]}
              hint={d.sources.length ? "Hôtes dont l'agent sait choisir son adresse source (agent 1.0.8 ou plus)." : "Aucun hôte avec agent récent dans les réseaux locaux du tunnel."}
            />
          </Step>
          <Step n={3} title="Cible" state={targetState} intro="Ce qui est pingué, de l'autre côté du tunnel.">
            <OptionList
              label="Hôte ou équipement distant"
              value={sel.host}
              onChange={(x) => set({ host: x })}
              search
              items={[
                ...(!targetKnown ? [{ value: sel.host, label: 'Cible hors des réseaux du tunnel', detail: sel.host, warn: true }] : []),
                ...d.targets.map((t) => ({ value: t.ip, label: t.gateway ? `${t.name} · passerelle distante` : t.name, detail: `${t.ip} · ${t.kind === 'host' ? 'hôte' : 'équipement'}` })),
              ]}
              hint="La passerelle distante est la cible la plus stable."
            />
          </Step>
          <Step
            n={4}
            title="Test"
            state={testState}
            intro={`Un ping immédiat${source ? ` depuis ${source.name} (${source.ip})` : ''}, rien n'est enregistré.`}
            footer={
              <Button className="w-full" variant={testState === 'active' ? 'primary' : 'secondary'} icon={Play} loading={busy === 'test'} disabled={busy !== null || !sel.sourceHostId || !sel.host} onClick={() => void runTest()}>
                {test ? 'Tester à nouveau' : 'Tester la sonde'}
              </Button>
            }
          >
            <CheckLine label="Trafic dans le tunnel" check={test} idle={source && sel.host ? `${source.ip} → ${sel.host}` : undefined} />
          </Step>
        </Steps>
      </Modal>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} title="Abandonner les modifications ?" confirmLabel="Abandonner" danger>
        Le choix de la source et de la cible ne sera pas enregistré.
      </ConfirmModal>
    </>
  );
}

export function VpnProbeModal({ probeId, onClose }: { probeId: string; onClose: () => void }) {
  const { data, error } = useQuery({ queryKey: ['vpn-probe', probeId], queryFn: () => api.vpnProbe(probeId) });
  if (data) return <Body d={data} onClose={onClose} />;
  return (
    <Modal open onClose={onClose} title="Sonde du tunnel">
      {error ? <p className="text-sm text-red-400">{(error as Error).message}</p> : <div className="flex justify-center p-6"><Spinner /></div>}
    </Modal>
  );
}
