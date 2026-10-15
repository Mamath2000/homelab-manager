import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, MapPin, Plus, Save, Tags, Trash2 } from 'lucide-react';
import { api, type SiteConfig, type SiteKind, type TagColor, type TagConfig } from '../lib/api';
import { keys, useHosts, useSites, useTags } from '../lib/queries';
import { siteKindMeta } from '../lib/sites';
import { useToast } from '../lib/toast';
import { ColorSwatches, TagChip } from './HostTags';
import { Button, ConfirmModal, Panel, Spinner } from './ui';

const KINDS = Object.keys(siteKindMeta) as SiteKind[];
type Draft = Omit<SiteConfig, 'id'> & { id?: string };

// Sites: name, tag and display order on the dashboard; each host picks its site in its form.
function SitesPanel() {
  const { data: sites } = useSites();
  const { data: hosts } = useHosts();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [saving, setSaving] = useState(false);
  if (!sites) return <div className="flex justify-center p-10"><Spinner /></div>;

  const list: Draft[] = draft ?? sites;
  const set = (next: Draft[]) => setDraft(next);
  const move = (i: number, d: -1 | 1) => {
    const next = list.slice();
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set(next);
  };
  const count = (id?: string) => (id ? (hosts ?? []).filter((h) => h.siteId === id).length : 0);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSites(list);
      await qc.invalidateQueries({ queryKey: keys.sites });
      setDraft(null);
      toast.success('Sites enregistrés');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="Sites"
      icon={MapPin}
      actions={<Button size="sm" variant="primary" icon={Save} loading={saving} disabled={!draft} onClick={save}>Enregistrer</Button>}
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Chaque hôte appartient à un site (choisi dans sa fiche). Le tableau de bord affiche les sites dans cet ordre ; les sites externes d'un seul hôte
          sont réunis dans une carte. Retirer un site le retire de ses hôtes.
        </p>
        {list.length === 0 && <p className="text-muted">Aucun site.</p>}
        <div className="space-y-2">
          {list.map((s, i) => (
            <div key={s.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2">
              <input
                className="input w-56"
                value={s.name}
                maxLength={64}
                aria-label="Nom du site"
                placeholder="Nom du site"
                onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <select
                className="input w-40"
                value={s.kind}
                aria-label="Type de site"
                onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, kind: e.target.value as SiteKind } : x)))}
              >
                {KINDS.map((k) => <option key={k} value={k}>{siteKindMeta[k].label}</option>)}
              </select>
              <Button size="sm" variant="ghost" icon={ArrowUp} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter" />
              <Button size="sm" variant="ghost" icon={ArrowDown} disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Descendre" />
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => set(list.filter((_, j) => j !== i))} aria-label="Retirer" />
              <span className="text-xs text-muted">{s.id ? `${count(s.id)} hôte${count(s.id) > 1 ? 's' : ''}` : 'nouveau'}</span>
            </div>
          ))}
        </div>
        <Button size="sm" icon={Plus} onClick={() => set([...list, { name: '', kind: list.length ? 'vpn' : 'main' }])}>Ajouter un site</Button>
      </div>
    </Panel>
  );
}

function TagRow({ tag, hosts }: { tag: TagConfig; hosts: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(tag.name);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (patch: { name?: string; color?: TagColor }) => {
    try {
      await api.updateTag(tag.id, patch);
      await qc.invalidateQueries({ queryKey: keys.tags });
    } catch (err) {
      setName(tag.name);
      toast.error((err as Error).message);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteTag(tag.id);
      await qc.invalidateQueries({ queryKey: keys.tags });
      setDeleting(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line py-2.5 first:border-t-0">
      <span className="w-28"><TagChip tag={{ ...tag, name: name || tag.name }} /></span>
      <input
        className="input w-44"
        value={name}
        maxLength={32}
        aria-label="Nom du tag"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== tag.name && save({ name: name.trim() })}
      />
      <ColorSwatches value={tag.color} onChange={(color) => save({ color })} />
      <span className="text-xs text-muted">{hosts} hôte{hosts > 1 ? 's' : ''}</span>
      <Button size="sm" variant="ghost" icon={Trash2} className="ml-auto hover:text-red-400" onClick={() => setDeleting(true)} aria-label={`Supprimer ${tag.name}`} />
      <ConfirmModal open={deleting} onClose={() => setDeleting(false)} title="Supprimer le tag" confirmLabel="Supprimer" danger loading={busy} onConfirm={remove}>
        Le tag <TagChip tag={tag} /> est retiré de {hosts} hôte{hosts > 1 ? 's' : ''}.
      </ConfirmModal>
    </div>
  );
}

// Tags: created from the host forms with their colour; renamed, recoloured or deleted here.
function TagsPanel() {
  const { data: tags } = useTags();
  const { data: hosts } = useHosts();
  if (!tags) return <div className="flex justify-center p-10"><Spinner /></div>;
  return (
    <Panel title="Tags" icon={Tags}>
      <div className="text-sm">
        <p className="mb-3 text-muted">Les tags se créent depuis la fiche d'un hôte (plusieurs par hôte, couleur au choix). Un changement s'applique à tous leurs hôtes.</p>
        {tags.length === 0 && <p className="text-muted">Aucun tag.</p>}
        {tags.map((t) => <TagRow key={t.id} tag={t} hosts={(hosts ?? []).filter((h) => h.tags.includes(t.id)).length} />)}
      </div>
    </Panel>
  );
}

export function SitesSettings() {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <SitesPanel />
      <TagsPanel />
    </div>
  );
}
