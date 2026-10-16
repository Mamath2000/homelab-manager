import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Tags, Trash2 } from 'lucide-react';
import { api, type TagColor, type TagConfig } from '../lib/api';
import { keys, useHosts, useTags } from '../lib/queries';
import { useToast } from '../lib/toast';
import { ColorSwatches, TagChip } from './HostTags';
import { SettingsFormActions } from './SettingsForm';
import { useSettingsDraft } from './settingsDraft';
import { Button, ConfirmModal, Panel, Spinner } from './ui';

function same<T>(a: T, b: T) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function TagsSettings() {
  const { data: tags } = useTags();
  const { data: hosts } = useHosts();
  const qc = useQueryClient();
  const toast = useToast();
  const [tagDraft, setTagDraft] = useState<TagConfig[] | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState<TagColor>('blue');
  const [saving, setSaving] = useState(false);
  const [confirmDeletes, setConfirmDeletes] = useState(false);

  const baselineTags = tags?.map((tag) => ({ ...tag })) ?? [];
  const currentTags = tagDraft ?? baselineTags;
  const hasNewTag = !!newTagName.trim();
  const dirty = !!tags && (!same(currentTags, baselineTags) || hasNewTag);
  const removedTags = baselineTags.filter((tag) => !currentTags.some((current) => current.id === tag.id));
  const affectedTagHosts = removedTags.reduce((count, tag) => count + (hosts ?? []).filter((host) => host.tags.includes(tag.id)).length, 0);
  const duplicateName = currentTags.some((tag, index) =>
    currentTags.some((other, otherIndex) => index !== otherIndex && tag.name.trim().toLocaleLowerCase() === other.name.trim().toLocaleLowerCase()),
  );
  const invalid = currentTags.some((tag) => !tag.name.trim()) || duplicateName;

  const discard = () => {
    setTagDraft(null);
    setNewTagName('');
    setNewTagColor('blue');
  };

  const save = async (allowDeletes = false): Promise<boolean> => {
    if (!tags) return false;
    if (invalid) {
      toast.error(duplicateName ? 'Chaque tag doit avoir un nom unique.' : 'Renseigne un nom pour chaque tag avant de continuer.');
      return false;
    }
    if (!allowDeletes && removedTags.length > 0) {
      setConfirmDeletes(true);
      return false;
    }
    setSaving(true);
    try {
      let workingTags = currentTags.slice();
      if (hasNewTag) {
        workingTags = [...workingTags, { id: `new-${Date.now()}`, name: newTagName.trim(), color: newTagColor }];
        setTagDraft(workingTags);
        setNewTagName('');
      }
      const baselineById = new Map(baselineTags.map((tag) => [tag.id, tag]));
      for (const tag of workingTags) {
        if (tag.id.startsWith('new-')) {
          const created = await api.createTag(tag.name.trim(), tag.color);
          workingTags = workingTags.map((item) => item.id === tag.id ? created : item);
          setTagDraft(workingTags);
        } else {
          const before = baselineById.get(tag.id);
          if (before && !same({ name: before.name, color: before.color }, { name: tag.name.trim(), color: tag.color })) {
            const updated = await api.updateTag(tag.id, { name: tag.name.trim(), color: tag.color });
            workingTags = workingTags.map((item) => item.id === tag.id ? updated : item);
            setTagDraft(workingTags);
          }
        }
      }
      for (const tag of removedTags) {
        await api.deleteTag(tag.id);
        workingTags = workingTags.filter((item) => item.id !== tag.id);
        setTagDraft(workingTags);
      }

      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.tags }),
        qc.invalidateQueries({ queryKey: keys.hosts }),
      ]);
      discard();
      setConfirmDeletes(false);
      toast.success('Tags enregistrés');
      return true;
    } catch (err) {
      toast.error(`Enregistrement des tags incomplet : ${(err as Error).message}. Les changements déjà appliqués ont été conservés.`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.tags }),
        qc.invalidateQueries({ queryKey: keys.hosts }),
      ]);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const markSaved = useSettingsDraft(dirty, () => save(), discard);
  if (!tags) return <div className="flex justify-center p-10"><Spinner /></div>;

  const countTagHosts = (id: string) => (hosts ?? []).filter((host) => host.tags.includes(id)).length;

  return (
    <Panel title="Tags" icon={Tags}>
      <div className="space-y-5 text-sm">
        <p className="text-muted">
          Les tags classent les hôtes et peuvent être utilisés dans les filtres. Les modifications restent en brouillon jusqu’à « Enregistrer ».
          Retirer un tag l’enlève des hôtes concernés.
        </p>
        {currentTags.length === 0 && <p className="text-xs text-muted">Aucun tag configuré.</p>}
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
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input w-48"
            maxLength={32}
            value={newTagName}
            onChange={(event) => setNewTagName(event.target.value)}
            placeholder="Nom du nouveau tag"
            aria-label="Nom du nouveau tag"
          />
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
        <SettingsFormActions dirty={dirty} saving={saving} onSave={() => void save()} onCancel={discard} />
      </div>
      <ConfirmModal
        open={confirmDeletes}
        onClose={() => setConfirmDeletes(false)}
        onConfirm={async () => {
          if (await save(true)) markSaved();
        }}
        title="Confirmer la suppression"
        confirmLabel="Enregistrer"
        danger
        loading={saving}
      >
        <p>{removedTags.length} tag(s) supprimé(s), ce qui retirera les tags de {affectedTagHosts} hôte(s).</p>
        <p className="mt-2">Les autres modifications seront également enregistrées.</p>
      </ConfirmModal>
    </Panel>
  );
}
