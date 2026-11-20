import { ArrowLeft, Radio } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router';
import { EsphomeSettings } from '../components/EsphomeSettings';
import { HeaderTitle } from '../components/HeaderSlot';
import { HomeAssistantPanel } from '../components/HomeAssistantPanel';
import { RolesSettings } from '../components/HubRoles';
import { LogHostsSettings } from '../components/LogHosts';
import { MqttSecuritySettings } from '../components/MqttSecurity';
import { OmadaInventory } from '../components/OmadaInventory';
import { PveInventory } from '../components/PveInventory';
import { ROLE_PAGES, type RolePageId } from '../lib/roleSettings';

// Rôles: the roles of the hub by type, in their own screen (out of Paramètres), at the bottom of the menu.
export function Roles() {
  return (
    <>
      <HeaderTitle icon={Radio} title="Rôles" />
      <RolesSettings />
    </>
  );
}

const content: Record<RolePageId, React.ReactNode> = {
  mqtt: <MqttSecuritySettings />,
  homeassistant: <HomeAssistantPanel />,
  pve: <PveInventory />,
  omada: <OmadaInventory />,
  esphome: <EsphomeSettings />,
  logs: <LogHostsSettings />,
};

// Rôles › <page>: the settings that come with a type of role (the accounts of the brokers, the inventory of the
// clusters…), opened from the section of that type.
export function RolePage() {
  const { page } = useParams();
  const def = ROLE_PAGES.find((p) => p.id === page);
  if (!def) return <Navigate to="/roles" replace />;
  return (
    <>
      <HeaderTitle
        icon={def.icon}
        title={`Rôles › ${def.label}`}
        back={
          <Link to="/roles" title="Retour aux rôles" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-sm text-muted transition hover:bg-raised hover:text-zinc-100">
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Rôles</span>
          </Link>
        }
      />
      {content[def.id]}
    </>
  );
}
