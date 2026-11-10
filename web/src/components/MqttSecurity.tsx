import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { api, type MqttHubRole } from '../lib/api';
import { keys } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useRoles } from '../lib/queries';
import { Badge, Button, ConfirmModal, Panel, Spinner } from './ui';

const STATE = { active: { tone: 'ok', label: 'Gestion des comptes active' }, available: { tone: 'neutral', label: 'Disponible, non activée' }, unavailable: { tone: 'warn', label: 'Indisponible' } } as const;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : '—');

// Paramètres › MQTT: the security of the MQTT brokers whose management of accounts is available or active
// (dynamic-security, run by the agent of the host), one panel per broker role.
export function MqttSecuritySettings() {
  const { data: roles = [] } = useRoles();
  const brokers = roles.filter((r): r is MqttHubRole => r.type === 'mqtt-broker' && r.security.state !== 'unavailable');
  if (!brokers.length) return <Panel title="Sécurité MQTT" icon={ShieldCheck}><p className="text-sm text-muted">Aucun broker MQTT déclaré dont la gestion des comptes soit disponible (Mosquitto 2.1 ou plus, agent à jour).</p></Panel>;
  return (
    <div className="space-y-4">
      {brokers.map((r) => (
        <BrokerSecurity key={r.id} role={r} />
      ))}
    </div>
  );
}

// One broker: state, the checks the agent makes, the activation (certificates by the CA of the hub, listener TLS, hub
// account by certificate) and its way back.
function BrokerSecurity({ role }: { role: MqttHubRole }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'enable' | 'disable' | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['mqtt-security', role.id], queryFn: () => api.mqttSecurity(role.id), refetchOnWindowFocus: false });
  const v = q.data;
  const state = v?.state ?? role.security.state;
  const hubManaged = !!v?.enabledAt;
  const checks = v?.report?.checks ?? [];
  const blocked = !!v && (!!v.error || !v.report?.eligible);

  const run = async (what: 'enable' | 'disable') => {
    setBusy(true);
    try {
      if (what === 'enable') await api.enableMqttSecurity(role.id);
      else await api.disableMqttSecurity(role.id);
      toast.success(what === 'enable' ? 'Gestion des comptes activée' : 'Gestion des comptes désactivée');
      setConfirm(null);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.roles }), qc.invalidateQueries({ queryKey: keys.mqttBrokers }), qc.invalidateQueries({ queryKey: ['mqtt-security', role.id] })]);
    } catch (err) {
      toast.error((err as Error).message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title={`Sécurité MQTT · ${role.name}`} icon={ShieldCheck}>
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATE[state].tone}>{STATE[state].label}</Badge>
            {(v?.version ?? role.security.version) && <span className="text-xs text-muted">Mosquitto {v?.version ?? role.security.version}</span>}
            {hubManaged && <span className="text-xs text-muted">activée le {date(v!.enabledAt)} · certificat du hub valable jusqu'au {date(v!.clientNotAfter)}</span>}
          </div>

          {state === 'unavailable' && <p className="text-muted">{role.security.reason ?? 'La gestion des comptes n\'est pas disponible sur ce broker.'}</p>}
          {state === 'active' && !hubManaged && !q.isLoading && (
            <p className="text-muted">Le plugin dynamic-security est chargé mais n'a pas été activé par le hub : il reste géré en dehors de HLM.</p>
          )}
          {state === 'active' && hubManaged && (
            <p className="text-muted">
              Le hub parle au broker en TLS mutuel (<code>{role.url}</code>) avec son propre certificat, sans mot de passe. Les clients anonymes restent acceptés
              (rôle <code>legacy</code>) ; un client qui se connecte avec un compte inconnu est refusé.
            </p>
          )}

          {state === 'available' && (
            <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              <p className="font-medium text-amber-300">À savoir avant d'activer</p>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>
                  <b>Les connexions avec un utilisateur inconnu seront refusées</b> : un appareil configuré avec un identifiant que le broker ne connaît pas ne se connecte plus. Les connexions
                  anonymes continuent d'être acceptées.
                </li>
                <li>Le broker est <b>redémarré</b> : tous les clients sont déconnectés quelques secondes.</li>
                <li>L'agent ajoute des fichiers (certificats, un fichier de configuration) sans modifier les vôtres ; en cas d'échec il les retire et redémarre.</li>
              </ul>
            </div>
          )}

          {(state === 'available' || state === 'active') && (
            <div>
              <p className="mb-1 text-[11px] font-medium tracking-wide text-muted uppercase">Contrôles de l'agent</p>
              {q.isLoading ? (
                <Spinner />
              ) : v?.error ? (
                <p className="text-xs text-red-400">{v.error}</p>
              ) : (
                <ul className="space-y-0.5 text-xs">
                  {checks.map((c, i) => (
                    <li key={i} className={c.level === 'error' ? 'text-red-400' : c.level === 'warn' ? 'text-amber-400' : 'text-muted'}>
                      {c.level === 'error' ? '✗' : c.level === 'warn' ? '!' : '·'} {c.detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {state === 'available' && (
              <Button variant="primary" icon={ShieldCheck} disabled={q.isLoading || blocked || busy} onClick={() => setConfirm('enable')}>
                Activer la gestion des comptes
              </Button>
            )}
            {state === 'active' && hubManaged && (
              <Button variant="danger" icon={ShieldOff} disabled={busy} onClick={() => setConfirm('disable')}>
                Désactiver
              </Button>
            )}
          </div>
        </div>
      </Panel>
      <ConfirmModal
        open={confirm === 'enable'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run('enable')}
        title="Activer la gestion des comptes"
        confirmLabel="Activer et redémarrer le broker"
        danger
        loading={busy}
      >
        Le broker <b>{role.name}</b> va être redémarré et ses clients déconnectés quelques secondes. <b>Les connexions avec un utilisateur inconnu seront ensuite refusées</b> ;
        les connexions anonymes restent acceptées.
      </ConfirmModal>
      <ConfirmModal
        open={confirm === 'disable'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run('disable')}
        title="Désactiver la gestion des comptes"
        confirmLabel="Désactiver et redémarrer le broker"
        danger
        loading={busy}
      >
        Le broker <b>{role.name}</b> va être redémarré avec sa configuration d'origine. Les comptes et rôles créés sont mis de côté sur l'hôte (pas supprimés) ; le hub
        retrouve le port d'avant, sans TLS.
      </ConfirmModal>
    </>
  );
}
