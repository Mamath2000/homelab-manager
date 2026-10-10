import type { DockerReport, DockerService, DockerStack, DockerUpdates, HostDoc } from './types.js';

// Same rules as the agent (agent/stacks.go): compose project and service names.
export const STACK_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export function isDockerReport(r: unknown): r is DockerReport {
  const x = r as DockerReport;
  return (
    !!x &&
    typeof x.checkedAt === 'number' &&
    Array.isArray(x.images) &&
    Array.isArray(x.stacks) &&
    x.stacks.every((s) => typeof s?.name === 'string' && Array.isArray(s.services) && s.services.every((v) => Array.isArray(v?.containers)))
  );
}

export function isDockerUpdates(u: unknown): u is DockerUpdates {
  const x = u as DockerUpdates;
  return !!x && typeof x.checkedAt === 'number' && Array.isArray(x.images) && x.images.every((i) => typeof i?.ref === 'string');
}

// available: a newer image is on the registry; recreate: the new image is already pulled but the
// container still runs the old one; unknown: never checked, not checkable (local build, pinned
// digest, private registry...) or failed.
export type ImageUpdate = 'available' | 'recreate' | 'uptodate' | 'unknown';

export interface ServiceView extends DockerService {
  update: ImageUpdate;
  localDigest: string | null;
  remoteDigest: string | null;
  checkError: string | null;
}

export interface StackView extends Omit<DockerStack, 'services'> {
  // false: managed elsewhere, read-only: image updates only (no state, problems nor actions)
  managed: boolean;
  services: ServiceView[];
  running: number;
  total: number;
  update: ImageUpdate;
  // services with an update to install (available or recreate)
  updates: number;
  // what needs attention: partial stack, unhealthy or restarting container
  problems: string[];
}

export interface DockerView {
  engine: string;
  compose: string;
  checkedAt: number;
  updatesCheckedAt: number | null;
  stacks: StackView[];
}

function serviceUpdate(svc: DockerService, report: DockerReport, updates?: DockerUpdates): Omit<ServiceView, keyof DockerService> {
  const img = report.images.find((i) => i.ref === svc.image);
  const check = updates?.images.find((i) => i.ref === svc.image);
  const remote = check?.digest || null;
  // an image can be known under several digests (tag republished with the same layers):
  // up to date when the registry one is among them
  const digests = img?.digests?.length ? img.digests : img?.digest ? [img.digest] : [];
  const local = (remote && digests.includes(remote) ? remote : digests[0]) || null;
  const base = { localDigest: local, remoteDigest: remote, checkError: check?.error || null };
  const recreate = !!img?.id && svc.containers.some((c) => c.imageId && c.imageId !== img.id);
  if (local && remote && local !== remote) return { ...base, update: 'available' };
  if (recreate) return { ...base, update: 'recreate' };
  if (local && remote) return { ...base, update: 'uptodate' };
  return { ...base, update: 'unknown' };
}

export function stackProblems(st: { status: string; running: number; total: number; services: DockerService[] }) {
  const out: string[] = [];
  if (st.status === 'partial') out.push(`${st.running}/${st.total} conteneurs en marche`);
  for (const svc of st.services) {
    for (const c of svc.containers) {
      if (c.health === 'unhealthy') out.push(`${svc.name} : en mauvaise santé`);
      if (c.state === 'restarting') out.push(`${svc.name} : redémarre en boucle`);
    }
  }
  return out;
}

export const isUnmanaged = (h: Pick<HostDoc, 'unmanagedStacks'>, stack: string) => !!h.unmanagedStacks?.includes(stack);

export function dockerView(h: HostDoc): DockerView | null {
  const r = h.docker;
  if (!r || !h.capabilities?.includes('docker')) return null;
  const stacks = r.stacks.map((st): StackView => {
    const services = st.services.map((svc) => ({ ...svc, ...serviceUpdate(svc, r, h.dockerUpdates) }));
    const has = (u: ImageUpdate) => services.some((s) => s.update === u);
    const update: ImageUpdate = has('available') ? 'available' : has('recreate') ? 'recreate' : has('uptodate') ? 'uptodate' : 'unknown';
    const updates = services.filter((s) => s.update === 'available' || s.update === 'recreate').length;
    // unmanaged: only the image updates (for information), nothing of the containers' state
    if (isUnmanaged(h, st.name)) {
      return { ...st, managed: false, services: services.map((s) => ({ ...s, containers: [] })), running: 0, total: 0, update, updates, problems: [] };
    }
    const containers = services.flatMap((s) => s.containers);
    const running = containers.filter((c) => c.state === 'running').length;
    const view = {
      ...st,
      managed: true,
      services,
      running,
      total: containers.length,
      update,
      updates,
      problems: [] as string[],
    };
    view.problems = stackProblems(view);
    return view;
  });
  return {
    engine: r.engine,
    compose: r.compose,
    checkedAt: r.checkedAt,
    updatesCheckedAt: h.dockerUpdates?.checkedAt ?? null,
    stacks,
  };
}

export function dockerSummary(v: DockerView | null) {
  if (!v) return null;
  const managed = v.stacks.filter((st) => st.managed);
  const count = (s: string) => managed.filter((st) => st.status === s).length;
  return {
    stacks: managed.length,
    running: count('running'),
    partial: count('partial'),
    stopped: count('stopped'),
    down: count('down'),
    updates: managed.filter((st) => st.updates > 0).length,
    problems: managed.filter((st) => st.problems.length > 0).length,
    unmanaged: v.stacks.length - managed.length,
  };
}

// The stack (and service) named by a request, from the last report of the host.
export function findStack(h: HostDoc, stack: string, service?: string) {
  const st = h.docker?.stacks.find((s) => s.name === stack);
  if (!st) return null;
  if (service && !st.services.some((s) => s.name === service)) return null;
  return st;
}
