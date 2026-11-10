import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Radio, RefreshCw, Users } from 'lucide-react';
import { api, type MqttHubRole } from '../lib/api';
import { stillRefused } from '../lib/roles';
import { Badge, Button, Panel } from './ui';
import { MqttAccountsModal } from './MqttSecurity';

function BrokerRow({ role }: { role: MqttHubRole }) {
  const [open, setOpen] = useState(false);
  // read when the page opens and on demand: no polling of the broker while the page stays open
  const q = useQuery({ queryKey: ['mqtt-accounts', role.id], queryFn: () => api.mqttAccounts(role.id), refetchOnWindowFocus: false });
  const accounts = (q.data?.accounts ?? []).filter((a) => !a.protected);
  const connected = accounts.filter((a) => a.connected).length;
  // without rights for the anonymous group a client that connects anonymously is refused, for the administrator
  const mute = q.data?.anonymousAllowed === false;
  const anonymousClients = q.data?.anonymous ?? [];
  const anonymous = mute ? 0 : anonymousClients.filter((a) => a.connected).length;
  const refused = (q.data?.refused ?? []).filter(stillRefused).length + (mute ? anonymousClients.length : 0);
  return (
    <div className="space-y-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-100">{role.name}</span>
        {role.security.version && <span className="text-xs text-muted">Mosquitto {role.security.version}</span>}
        <span className="font-mono text-xs text-muted">{role.url}</span>
      </div>
      {q.error ? (
        <p className="text-xs text-red-400">{(q.error as Error).message}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <span>
            <b className="text-zinc-100">{q.isLoading ? '…' : accounts.length}</b> <span className="text-muted">compte{accounts.length > 1 ? 's' : ''} enregistré{accounts.length > 1 ? 's' : ''}</span>
          </span>
          <span>
            <b className="text-zinc-100">{q.isLoading ? '…' : connected}</b> <span className="text-muted">connecté{connected > 1 ? 's' : ''}</span>
          </span>
          <span>
            {anonymous > 0 ? <Badge tone="warn">{anonymous} anonyme{anonymous > 1 ? 's' : ''} connecté{anonymous > 1 ? 's' : ''}</Badge> : <span className="text-muted">aucun anonyme connecté</span>}
          </span>
          <span>
            {refused > 0 ? <Badge tone="bad">{refused} client{refused > 1 ? 's' : ''} refusé{refused > 1 ? 's' : ''}</Badge> : <span className="text-muted">aucun client refusé</span>}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" icon={Users} onClick={() => setOpen(true)}>Gérer les comptes</Button>
        <Button size="sm" icon={RefreshCw} loading={q.isFetching} disabled={q.isFetching} aria-label="Actualiser" title="Actualiser" onClick={() => void q.refetch()} />
        <Link className="text-xs text-muted underline" to="/settings?tab=mqtt">Réglages de la sécurité</Link>
      </div>
      {open && <MqttAccountsModal role={role} onClose={() => setOpen(false)} />}
    </div>
  );
}

// The brokers of a host whose accounts the hub manages (dynamic-security activated from Settings › MQTT): a summary and
// the dialog of the accounts. The setup stays in the settings.
export function HostMqttPanel({ roles }: { roles: MqttHubRole[] }) {
  return (
    <Panel title="MQTT géré par HLM" icon={Radio}>
      <div className="space-y-4 divide-y divide-line [&>*:not(:first-child)]:pt-4">
        {roles.map((r) => (
          <BrokerRow key={r.id} role={r} />
        ))}
      </div>
    </Panel>
  );
}
