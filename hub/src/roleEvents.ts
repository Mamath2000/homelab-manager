import type { ObjectId } from 'mongodb';
import { hosts } from './db.js';
import { publish } from './events.js';
import { hostDto } from './hostDto.js';
import { loadRoles } from './roles.js';

// After a role is written: the cache, the probes and the bridge (brokers, 'probe.config') and the hosts that carry or
// carried it.
export async function rolesSaved(carriers: ObjectId[]) {
  await loadRoles();
  publish('probe.config', {});
  for (const h of await hosts.find({ _id: { $in: carriers } }).toArray()) publish('host', hostDto(h));
}
