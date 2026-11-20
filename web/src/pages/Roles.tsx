import { Radio } from 'lucide-react';
import { HeaderTitle } from '../components/HeaderSlot';
import { RolesSettings } from '../components/HubRoles';

// Rôles: the roles of the hub by type, in their own screen (out of Paramètres), at the bottom of the menu. The options a
// role unlocks open in a window over it: /roles/<page>?role=<id> (RolesSettings reads the URL).
export function Roles() {
  return (
    <>
      <HeaderTitle icon={Radio} title="Rôles" />
      <RolesSettings />
    </>
  );
}
