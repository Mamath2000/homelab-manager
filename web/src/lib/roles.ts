import type { Host } from './api';

// Services the agent found that are not a role yet (a role on the same port counts as activated); the ones that
// listen on loopback only are left out: the hub cannot reach them.
export const offeredCandidates = (host: Host) => (host.roleCandidates ?? []).filter((c) => !c.local && !host.roles.some((r) => r.port === c.port));
