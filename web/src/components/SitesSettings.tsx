import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, MapPin, Plus, Save, Trash2 } from 'lucide-react';
import { api, type SiteConfig, type SiteKind } from '../lib/api';
import { keys, useSites } from '../lib/queries';
import { siteKindMeta } from '../lib/sites';
import { useToast } from '../lib/toast';
import { Button, Panel, Spinner, Tag } from './ui';

const KINDS = Object.keys(siteKindMeta) as SiteKind[];

// Sites of the dashboard: a site is a group of hosts (field "Groupe"); here its tag and its order.
export function SitesSettings() {
  const { data } = useSites();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<SiteConfig[] | null>(null);
  const [saving, setSaving] = useState(false);
  if (!data) return <div className="flex justify-center p-10"><Spinner /></div>;

  const list = draft ?? data.sites;
  const set = (next: SiteConfig[]) => setDraft(next);
  const move = (i: number, d: -1 | 1) => {
    const next = list.slice();
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set(next);
  };
  const missing = data.groups.filter((g) => !list.some((s) => s.name === g));

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
      title="Sites du tableau de bord"
      icon={MapPin}
      actions={<Button size="sm" variant="primary" icon={Save} loading={saving} disabled={!draft} onClick={save}>Enregistrer</Button>}
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Un site regroupe les hôtes qui ont la même valeur dans le champ <b className="text-zinc-300">Groupe</b>. Le tableau de bord affiche les sites listés ici
          dans cet ordre, avec leur étiquette, puis les autres groupes. Les sites externes d'un seul hôte sont réunis dans une carte.
        </p>
        {list.length === 0 && <p className="text-muted">Aucun site configuré.</p>}
        <div className="space-y-2">
          {list.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                className="input w-56"
                value={s.name}
                maxLength={64}
                aria-label="Nom du groupe"
                onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <select
                className="input w-40"
                value={s.kind}
                aria-label="Étiquette"
                onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, kind: e.target.value as SiteKind } : x)))}
              >
                {KINDS.map((k) => <option key={k} value={k}>{siteKindMeta[k].label}</option>)}
              </select>
              <Button size="sm" variant="ghost" icon={ArrowUp} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter" />
              <Button size="sm" variant="ghost" icon={ArrowDown} disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Descendre" />
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => set(list.filter((_, j) => j !== i))} aria-label="Retirer" />
              {!data.groups.includes(s.name.trim()) && s.name.trim() && <span className="text-xs text-amber-400">aucun hôte dans ce groupe</span>}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={Plus} onClick={() => set([...list, { name: '', kind: 'vpn' }])}>Ajouter un site</Button>
          {missing.length > 0 && <span className="text-xs text-muted">Groupes existants :</span>}
          {missing.map((g) => (
            <button key={g} type="button" className="hover:opacity-80" title="Ajouter ce groupe" onClick={() => set([...list, { name: g, kind: list.length ? 'vpn' : 'main' }])}>
              <Tag>+ {g}</Tag>
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}
