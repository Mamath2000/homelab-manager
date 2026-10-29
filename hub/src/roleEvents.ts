import { ObjectId } from 'mongodb';
import { hosts } from './db.js';
import { publish, subscribe } from './events.js';
import { hostDto } from './hostDto.js';
import { allRoles, loadRoles } from './roles.js';

// After a role is written: the cache, the probes and the bridge (brokers, 'probe.config') and the hosts that carry or
// carried it.
export async function rolesSaved(carriers: ObjectId[]) {
  await loadRoles();
  publish('probe.config', {});
  await publishHosts(carriers);
}

async function publishHosts(ids: ObjectId[]) {
  for (const h of await hosts.find({ _id: { $in: ids } }).toArray()) publish('host', hostDto(h));
}

// what carries a PBS role, as type:hostId
const pbsCarriers = () => new Set(allRoles().flatMap((r) => (r.type === 'pbs-primary' || r.type === 'pbs-offsite' ? [`${r.type}:${r.carrier.id.toHexString()}`] : [])));

// The PBS roles live in the settings of the backups, whose changes are told by 'backups' (settings, poll, disconnection):
// the cache follows, then the hosts that carry or carried one, and the UI ('roles').
export function watchSettingsRoles() {
  let running = false;
  let again = false;
  const run = async () => {
    running = true;
    do {
      again = false;
      const before = pbsCarriers();
      await loadRoles();
      const after = pbsCarriers();
      const changed = [...before, ...after].filter((k) => before.has(k) !== after.has(k)).map((k) => k.split(':')[1]);
      await publishHosts([...new Set(changed)].map((id) => new ObjectId(id)));
      publish('roles', {});
    } while (again);
    running = false;
  };
  return subscribe((event) => {
    if (event !== 'backups') return;
    if (running) again = true;
    else run().catch(() => (running = false));
  });
}
