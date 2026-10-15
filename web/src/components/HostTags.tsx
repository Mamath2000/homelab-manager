import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { MapPin, Plus, X } from 'lucide-react';
import { api, TAG_COLORS, type Host, type TagColor, type TagConfig } from '../lib/api';
import { keys, useSites, useTags } from '../lib/queries';
import { useToast } from '../lib/toast';
import { tagChip, tagSwatch } from '../lib/tags';
import { Button } from './ui';

export function TagChip({ tag, onRemove }: { tag: TagConfig; onRemove?: () => void }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-semibold ring-1 ring-inset', tagChip[tag.color])}>
      {tag.name}
      {onRemove && (
        <button type="button" aria-label={`Retirer ${tag.name}`} onClick={onRemove} className="-mr-1 rounded-sm opacity-70 hover:opacity-100">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

// Tags of a host, in the order of the catalog.
export function HostTagList({ host }: { host: Pick<Host, 'tags'> }) {
  const { data: tags } = useTags();
  return <>{(tags ?? []).filter((t) => host.tags.includes(t.id)).map((t) => <TagChip key={t.id} tag={t} />)}</>;
}

// Name of the site of a host, null: none.
function useSiteName() {
  const { data: sites } = useSites();
  return (h: Pick<Host, 'siteId'>) => sites?.find((s) => s.id === h.siteId)?.name ?? null;
}

export function SiteChip({ host }: { host: Pick<Host, 'siteId'> }) {
  const name = useSiteName()(host);
  if (!name) return null;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm bg-zinc-800/80 px-2 py-0.5 text-xs font-semibold text-zinc-200">
      <MapPin className="h-3 w-3 text-muted" />
      {name}
    </span>
  );
}

export function SiteSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data: sites } = useSites();
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">Site</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Aucun site</option>
        {(sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {sites?.length === 0 && (
        <span className="mt-1 block text-xs text-zinc-500">
          Les sites se décrivent dans <Link to="/settings?tab=sites" className="text-emerald-400 hover:underline">Paramètres › Sites et tags</Link>.
        </span>
      )}
    </label>
  );
}

export function ColorSwatches({ value, onChange }: { value: TagColor; onChange: (c: TagColor) => void }) {
  return (
    <span role="radiogroup" aria-label="Couleur" className="inline-flex flex-wrap gap-1.5">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={c}
          onClick={() => onChange(c)}
          className={clsx('h-5 w-5 rounded-full ring-offset-2 ring-offset-panel transition', tagSwatch[c], c === value ? 'ring-2 ring-zinc-100' : 'opacity-70 hover:opacity-100')}
        />
      ))}
    </span>
  );
}

// Tags of a host in a form: pick existing ones, or create one with its colour.
export function TagPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { data: tags } = useTags();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [color, setColor] = useState<TagColor>('blue');
  const [busy, setBusy] = useState(false);
  const all = tags ?? [];
  const chosen = all.filter((t) => value.includes(t.id));
  const needle = text.trim().toLowerCase();
  const offered = all.filter((t) => !value.includes(t.id) && (!needle || t.name.toLowerCase().includes(needle)));
  const exists = all.some((t) => t.name.toLowerCase() === needle);

  const create = async () => {
    setBusy(true);
    try {
      const tag = await api.createTag(text.trim(), color);
      qc.setQueryData<{ tags: TagConfig[] }>(keys.tags, (old) => ({ tags: [...(old?.tags ?? []), tag] }));
      onChange([...value, tag.id]);
      setText('');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">Tags</span>
      {chosen.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chosen.map((t) => <TagChip key={t.id} tag={t} onRemove={() => onChange(value.filter((id) => id !== t.id))} />)}
        </div>
      )}
      <input
        className="input"
        maxLength={32}
        value={text}
        placeholder="Chercher ou créer un tag…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter: the only tag left, or a new one; never submits the form
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (offered.length === 1 && needle) {
            onChange([...value, offered[0].id]);
            setText('');
          } else if (needle && !exists && !busy) create();
        }}
      />
      {offered.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {offered.slice(0, 12).map((t) => (
            <button key={t.id} type="button" className="hover:brightness-125" onClick={() => { onChange([...value, t.id]); setText(''); }}>
              <TagChip tag={t} />
            </button>
          ))}
        </div>
      )}
      {needle && !exists && (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-line bg-raised/50 p-2.5">
          <span className="text-xs text-muted">Nouveau tag</span>
          <TagChip tag={{ id: '', name: text.trim(), color }} />
          <ColorSwatches value={color} onChange={setColor} />
          <Button type="button" size="sm" icon={Plus} loading={busy} onClick={create}>Créer</Button>
        </div>
      )}
    </div>
  );
}
