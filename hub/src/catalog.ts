import { ObjectId } from 'mongodb';
import { hosts, settings } from './db.js';
import { TAG_COLORS, type SiteConfig, type SitesSettings, type TagColor, type TagConfig, type TagsSettings } from './types.js';

// Sites (settings, one per host) and tags (several per host, coloured).

const newId = () => new ObjectId().toHexString();

export async function loadSites(): Promise<SiteConfig[]> {
  const doc = (await settings.findOne({ _id: 'sites' })) as SitesSettings | null;
  return doc?.sites ?? [];
}

export async function loadTags(): Promise<TagConfig[]> {
  const doc = (await settings.findOne({ _id: 'tags' })) as TagsSettings | null;
  return doc?.tags ?? [];
}

export const saveTags = (tags: TagConfig[]) => settings.replaceOne({ _id: 'tags' }, { _id: 'tags', tags }, { upsert: true });

// Names trimmed, empty ones dropped, an id given to the new sites. null: a name is given twice.
export function normalizeSites(list: (Omit<SiteConfig, 'id' | 'color'> & { id?: string; color?: TagColor })[]): SiteConfig[] | null {
  const out: SiteConfig[] = [];
  for (const s of list) {
    const name = s.name.trim();
    if (!name) continue;
    if (out.some((o) => o.name.toLowerCase() === name.toLowerCase())) return null;
    out.push({ id: s.id || newId(), name, kind: s.kind, color: s.color ?? 'zinc' });
  }
  return out;
}

export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Colour of the n-th tag created without one (migration): the palette in turn, grey left out.
export const autoColor = (n: number): TagColor => TAG_COLORS[1 + (n % (TAG_COLORS.length - 1))];

// The group of the first versions becomes a tag (created once per name) and, when a site has its name,
// the site of the host. Pure: what migrateGroups writes.
export function planGroupMigration(list: { id: string; group: string; tags?: string[]; siteId?: string }[], sites: SiteConfig[], tags: TagConfig[]) {
  const next = tags.slice();
  const updates = list.map((h) => {
    let tag = next.find((t) => sameName(t.name, h.group));
    if (!tag) {
      tag = { id: newId(), name: h.group.trim(), color: autoColor(next.length) };
      next.push(tag);
    }
    const site = sites.find((s) => sameName(s.name, h.group));
    return { id: h.id, tags: [...new Set([...(h.tags ?? []), tag.id])], siteId: h.siteId ?? site?.id };
  });
  return { tags: next, updates };
}

export async function migrateGroups() {
  // sites saved by the first version of the settings had no id
  const raw = await loadSites();
  const sites = raw.map((s) => (s.id ? s : { ...s, id: newId() }));
  if (raw.some((s) => !s.id)) await settings.replaceOne({ _id: 'sites' }, { _id: 'sites', sites }, { upsert: true });

  const legacy = await hosts.find({ group: { $exists: true } }, { projection: { group: 1, tags: 1, siteId: 1 } }).toArray();
  const withGroup = legacy.filter((h) => h.group?.trim()).map((h) => ({ id: h._id.toHexString(), group: h.group!, tags: h.tags, siteId: h.siteId }));
  const plan = planGroupMigration(withGroup, sites, await loadTags());
  if (withGroup.length) await saveTags(plan.tags);
  for (const u of plan.updates) {
    await hosts.updateOne({ _id: new ObjectId(u.id) }, { $set: { tags: u.tags, ...(u.siteId ? { siteId: u.siteId } : {}) }, $unset: { group: '' } });
  }
  // empty groups: nothing to keep
  await hosts.updateMany({ group: { $exists: true } }, { $unset: { group: '' } });
}

// Host fields given by the interface: a known site (or none), known tags. Error text, or null.
export async function checkHostLinks(siteId: string | undefined, tagIds: string[] | undefined) {
  if (siteId && !(await loadSites()).some((s) => s.id === siteId)) return 'site inconnu';
  if (tagIds?.length) {
    const known = new Set((await loadTags()).map((t) => t.id));
    if (tagIds.some((t) => !known.has(t))) return 'tag inconnu';
  }
  return null;
}
