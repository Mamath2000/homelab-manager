import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, MapPin, Plus, Tags, Trash2 } from 'lucide-react';
import { api, type SiteConfig, type SiteKind, type TagColor, type TagConfig } from '../lib/api';
import { keys, useHosts, useSites, useTags } from '../lib/queries';
import { siteKindMeta } from '../lib/sites';
import { useToast } from '../lib/toast';
import { ColorSwatches, TagChip } from './HostTags';
import { SettingsFormActions } from './SettingsForm';
import { useSettingsDraft } from './settingsDraft';
import { Button, ConfirmModal, Panel, Spinner } from './ui';

const KINDS = Object.keys(siteKindMeta) as SiteKind[];
type SiteDraft = Omit<SiteConfig, 'id'> & { id?: string };
type TagDraft = TagConfig;

function same<T>(a: T, b: T) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function SitesSettings() {
  const { data: sites } = useSites();
  const { data: tags } = useTags();
  const { data: hosts } = useHosts();
  const qc = useQueryClient();
  const toast = useToast();
  const [siteDraft, setSiteDraft] = useState<SiteDraft[] | null>(null);
  const [tagDraft, setTagDraft] = useState<TagDraft[] | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState<TagColor>('blue');
  const [saving, setSaving] = useState(false);
  const [confirmDeletes, setConfirmDeletes] = useState(false);

  const baselineSites = sites?.map((site) => ({ ...site })) ?? [];
  const baselineTags = tags?.map((tag) => ({ ...tag })) ?? [];
  const currentSites = siteDraft ?? baselineSites;
  const currentTags = tagDraft ?? baselineTags;
  const hasNewTag = !!newTagName.trim();
  const dirty = !!sites && !!tags && (!same(currentSites, baselineSites) || !same(currentTags, baselineTags) || hasNewTag);
  const removedSites = baselineSites.filter((site) => site.id && !currentSites.some((current) => current.id === site.id));
  const removedTags = baselineTags.filter((tag) => !currentTags.some((current) => current.id === tag.id));
  const affectedSiteHosts = removedSites.reduce((count, site) => count + (hosts ?? []).filter((host) => host.siteId === site.id).length, 0);
  const affectedTagHosts = removedTags.reduce((count, tag) => count + (hosts ?? []).filter((host) => host.tags.includes(tag.id)).length, 0);
  const invalid = currentSites.some((site) => !site.name.trim()) || currentTags.some((tag) => !tag.name.trim());

  const discard = () => {
    setSiteDraft(null);
    setTagDraft(null);
    setNewTagName('');
    setNewTagColor('blue');
  };

  const save = async (allowDeletes = false): Promise<boolean> => {
    if (!sites || !tags) return false;
    if (invalid) {
      toast.error('Renseigne un nom pour chaque site et tag avant de continuer.');
      return false;
    }
    if (!allowDeletes && removedSites.length + removedTags.length > 0) {
      setConfirmDeletes(true);
      return false;
    }
    setSaving(true);
    try {
      if (!same(currentSites, baselineSites)) {
        const result = await api.saveSites(currentSites);
        setSiteDraft(result.sites);
        qc.setQueryData<{ sites: SiteConfig[] }>(keys.sites, { sites: result.sites });
      }

      const tagsToSave = hasNewTag
        ? [...currentTags, { id: `new-${Date.now()}`, name: newTagName.trim(), color: newTagColor }]
        : currentTags;
      if (hasNewTag) {
        setTagDraft(tagsToSave);
        setNewTagName('');
      }
      const baselineById = new Map(baselineTags.map((tag) => [tag.id, tag]));
      for (const tag of tagsToSave) {
        if (tag.id.startsWith('new-')) {
          const created = await api.createTag(tag.name.trim(), tag.color);
          setTagDraft((draft) => draft?.map((item) => item.id === tag.id ? created : item) ?? null);
        } else {
          const before = baselineById.get(tag.id);
          if (before && !same({ name: before.name, color: before.color }, { name: tag.name.trim(), color: tag.color })) {
            await api.updateTag(tag.id, { name: tag.name.trim(), color: tag.color });
          }
        }
      }
      for (const tag of removedTags) await api.deleteTag(tag.id);

      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.sites }),
        qc.invalidateQueries({ queryKey: keys.tags }),
      ]);
      discard();
      setConfirmDeletes(false);
      toast.success('Sites et tags enregistrés');
      return true;
    } catch (err) {
      toast.error(`Enregistrement incomplet : ${(err as Error).message}. Les changements déjà appliqués ont été conservés.`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.sites }),
        qc.invalidateQueries({ queryKey: keys.tags }),
        qc.invalidateQueries({ queryKey: keys.hosts }),
      ]);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const markSaved = useSettingsDraft(dirty, () => save(), discard);
  if (!sites || !tags) return <div className="flex justify-center p-10"><Spinner /></div>;

  const requestSave = () => void save();
  const countSiteHosts = (id?: string) => id ? (hosts ?? []).filter((host) => host.siteId === id).length : 0;
  const countTagHosts = (id: string) => (hosts ?? []).filter((host) => host.tags.includes(id)).length;

  return (
    <Panel title="Sites et tags" icon={MapPin}>
      <div className="space-y-6 text-sm">
        <p className="text-muted">
          Les modifications restent en brouillon jusqu’à « Enregistrer ». Retirer un site détache ses hôtes ; retirer un tag l’enlève des hôtes concernés.
        </p>

        <section>
          <h3 className="mb-3 flex items-center gap-2 font-medium text-zinc-100"><MapPin className="h-4 w-4 text-muted" />Sites</h3>
          {currentSites.length === 0 && <p className="mb-3 text-xs text-muted">Aucun site configuré.</p>}
          <div className="space-y-2">
            {currentSites.map((site, index) => (
              <div key={site.id ?? `new-site-${index}`} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-raised/20 p-2">
                <input
                  className="input w-52"
                  value={site.name}
                  maxLength={64}
                  aria-label="Nom du site"
                  placeholder="Nom du site"
                  onChange={(event) => setSiteDraft(currentSites.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}
                />
                <select
                  className="input w-40"
                  value={site.kind}
                  aria-label="Type de site"
                  onChange={(event) => setSiteDraft(currentSites.map((item, i) => i === index ? { ...item, kind: event.target.value as SiteKind } : item))}
                >
                  {KINDS.map((kind) => <option key={kind} value={kind}>{siteKindMeta[kind].label}</option>)}
                </select>
                <ColorSwatches value={site.color ?? 'zinc'} onChange={(color) => setSiteDraft(currentSites.map((item, i) => i === index ? { ...item, color } : item))} />
                <Button size="sm" variant="ghost" icon={ArrowUp} disabled={index === 0 || saving} onClick={() => {
                  const next = currentSites.slice();
                  [next[index - 1], next[index]] = [next[index], next[index - 1]];
                  setSiteDraft(next);
                }} aria-label="Monter" />
                <Button size="sm" variant="ghost" icon={ArrowDown} disabled={index === currentSites.length - 1 || saving} onClick={() => {
                  const next = currentSites.slice();
                  [next[index], next[index + 1]] = [next[index + 1], next[index]];
                  setSiteDraft(next);
                }} aria-label="Descendre" />
                <span className="text-xs text-muted">{site.id ? `${countSiteHosts(site.id)} hôte(s)` : 'nouveau'}</span>
                <Button size="sm" variant="ghost" icon={Trash2} disabled={saving} className="ml-auto hover:text-red-400" onClick={() => setSiteDraft(currentSites.filter((_, i) => i !== index))} aria-label={`Retirer ${site.name || 'le site'}`} />
              </div>
            ))}
          </div>
          <Button size="sm" icon={Plus} className="mt-3" disabled={saving} onClick={() => setSiteDraft([...currentSites, { name: '', kind: currentSites.length ? 'vpn' : 'main', color: 'blue' }])}>Ajouter un site</Button>
        </section>

        <section className="border-t border-line pt-5">
          <h3 className="mb-3 flex items-center gap-2 font-medium text-zinc-100"><Tags className="h-4 w-4 text-muted" />Tags</h3>
          <p className="mb-3 text-xs text-muted">Les tags classent les hôtes et peuvent être utilisés dans les filtres.</p>
          {currentTags.length === 0 && <p className="mb-3 text-xs text-muted">Aucun tag configuré.</p>}
          <div className="space-y-2">
            {currentTags.map((tag) => (
              <div key={tag.id} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-raised/20 p-2">
                <TagChip tag={{ ...tag, name: tag.name || 'Nouveau tag' }} />
                <input
                  className="input w-48"
                  value={tag.name}
                  maxLength={32}
                  aria-label="Nom du tag"
                  placeholder="Nom du tag"
                  onChange={(event) => setTagDraft(currentTags.map((item) => item.id === tag.id ? { ...item, name: event.target.value } : item))}
                />
                <ColorSwatches value={tag.color} onChange={(color) => setTagDraft(currentTags.map((item) => item.id === tag.id ? { ...item, color } : item))} />
                <span className="text-xs text-muted">{tag.id.startsWith('new-') ? 'nouveau' : `${countTagHosts(tag.id)} hôte(s)`}</span>
                <Button size="sm" variant="ghost" icon={Trash2} disabled={saving} className="ml-auto hover:text-red-400" onClick={() => setTagDraft(currentTags.filter((item) => item.id !== tag.id))} aria-label={`Retirer ${tag.name || 'le tag'}`} />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input className="input w-48" maxLength={32} value={newTagName} onChange={(event) => setNewTagName(event.target.value)} placeholder="Nom du nouveau tag" aria-label="Nom du nouveau tag" />
            <ColorSwatches value={newTagColor} onChange={setNewTagColor} />
            <Button
              size="sm"
              icon={Plus}
              disabled={!newTagName.trim() || saving || currentTags.some((tag) => tag.name.trim().toLocaleLowerCase() === newTagName.trim().toLocaleLowerCase())}
              onClick={() => {
                setTagDraft([...currentTags, { id: `new-${Date.now()}`, name: newTagName.trim(), color: newTagColor }]);
                setNewTagName('');
                setNewTagColor('blue');
              }}
            >
              Ajouter un tag
            </Button>
          </div>
        </section>

        <SettingsFormActions dirty={dirty} saving={saving} onSave={requestSave} onCancel={discard} />
      </div>
      <ConfirmModal
        open={confirmDeletes}
        onClose={() => setConfirmDeletes(false)}
        onConfirm={async () => {
          if (await save(true)) markSaved();
        }}
        title="Confirmer les suppressions"
        confirmLabel="Enregistrer"
        danger
        loading={saving}
      >
        {removedSites.length > 0 && <p>{removedSites.length} site(s) supprimé(s), ce qui détachera {affectedSiteHosts} hôte(s).</p>}
        {removedTags.length > 0 && <p>{removedTags.length} tag(s) supprimé(s), ce qui retirera les tags de {affectedTagHosts} hôte(s).</p>}
        <p className="mt-2">Les autres modifications seront également enregistrées.</p>
      </ConfirmModal>
    </Panel>
  );
}
