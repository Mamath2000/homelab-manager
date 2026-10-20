import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, MapPin, Plus, X } from 'lucide-react';
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

export function SiteChip({ host, prominent }: { host: Pick<Host, 'siteId'>; prominent?: boolean }) {
  const { data: sites } = useSites();
  const site = sites?.find((item) => item.id === host.siteId);
  if (!site) return null;
  return (
    <span className={clsx(
      'inline-flex items-center whitespace-nowrap rounded-md font-semibold ring-1 ring-inset',
      tagChip[site.color ?? 'zinc'],
      prominent ? 'min-w-[22rem] justify-center gap-2 px-4 py-2 text-lg' : 'gap-1 px-2 py-0.5 text-xs',
    )}>
      <MapPin className={prominent ? 'h-5 w-5' : 'h-3 w-3'} />
      {site.name}
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
          Les sites se décrivent dans <Link to="/settings?tab=sites" className="text-emerald-400 hover:underline">Paramètres › Sites</Link>.
        </span>
      )}
    </label>
  );
}

export function ColorSwatches({ value, onChange, disabled }: { value: TagColor; onChange: (c: TagColor) => void; disabled?: boolean }) {
  return (
    <span role="radiogroup" aria-label="Couleur" className="inline-flex flex-wrap gap-1.5">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={c}
          disabled={disabled}
          onClick={() => onChange(c)}
          className={clsx('h-5 w-5 rounded-full ring-offset-2 ring-offset-panel transition disabled:cursor-not-allowed disabled:opacity-40', tagSwatch[c], c === value ? 'ring-2 ring-zinc-100' : 'opacity-70 hover:opacity-100')}
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
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-zinc-100">Tags</h4>
        <p className="mt-1 text-xs text-muted">Classez l’hôte pour le retrouver et le filtrer facilement.</p>
      </div>

      <div className="rounded-md border border-emerald-500/25 bg-emerald-500/[0.04] p-3">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-emerald-300">
          Sélectionnés <span className="tabular-nums">({chosen.length})</span>
        </p>
        {chosen.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {chosen.map((t) => <TagChip key={t.id} tag={t} onRemove={() => onChange(value.filter((id) => id !== t.id))} />)}
          </div>
        ) : (
          <p className="text-xs text-muted">Aucun tag sélectionné.</p>
        )}
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-300" htmlFor="host-tag-search">Ajouter un tag</label>
        <input
          id="host-tag-search"
          className="input"
          maxLength={32}
          value={text}
          placeholder="Rechercher un tag existant ou en créer un…"
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
      </div>

      {offered.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
            Tags disponibles{offered.length > 12 ? ` · ${offered.length}` : ''}
          </p>
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {offered.slice(0, 12).map((t) => (
              <button
                key={t.id}
                type="button"
                aria-label={`Ajouter le tag ${t.name}`}
                className="group inline-flex items-center gap-1 rounded-sm border border-line/70 px-1.5 py-0.5 opacity-65 transition hover:border-emerald-500/40 hover:bg-emerald-500/5 hover:opacity-100"
                onClick={() => { onChange([...value, t.id]); setText(''); }}
              >
                <Plus className="h-3 w-3 text-muted group-hover:text-emerald-300" />
                <TagChip tag={t} />
              </button>
            ))}
          </div>
        </div>
      )}
      {needle && exists && offered.length === 0 && (
        <p className="text-xs text-muted">Ce tag est déjà sélectionné.</p>
      )}
      {needle && !exists && (
        <div className="space-y-2 rounded-md border border-line bg-raised/50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-zinc-200">Créer un nouveau tag</span>
            <TagChip tag={{ id: '', name: text.trim(), color }} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="mb-1 text-[11px] text-muted">Choisir sa couleur</p>
              <ColorSwatches value={color} onChange={setColor} />
            </div>
            <Button type="button" size="sm" icon={Check} loading={busy} onClick={create}>Créer et ajouter</Button>
          </div>
        </div>
      )}
    </div>
  );
}
