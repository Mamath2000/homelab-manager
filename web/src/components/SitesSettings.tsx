import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, MapPin, Plus, Trash2 } from 'lucide-react';
import { api, type SiteConfig, type SiteKind } from '../lib/api';
import { keys, useHosts, useSites } from '../lib/queries';
import { siteKindMeta } from '../lib/sites';
import { useToast } from '../lib/toast';
import { ColorSwatches } from './HostTags';
import { SettingsFormActions } from './SettingsForm';
import { useSettingsDraft } from './settingsDraft';
import { Button, ConfirmModal, Panel, Spinner } from './ui';

const KINDS = Object.keys(siteKindMeta) as SiteKind[];
type SiteDraft = Omit<SiteConfig, 'id'> & { id?: string };

function same<T>(a: T, b: T) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function SitesSettings() {
  const { data: sites } = useSites();
  const { data: hosts } = useHosts();
  const qc = useQueryClient();
  const toast = useToast();
  const [siteDraft, setSiteDraft] = useState<SiteDraft[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeletes, setConfirmDeletes] = useState(false);

  const baselineSites = sites?.map((site) => ({ ...site })) ?? [];
  const currentSites = siteDraft ?? baselineSites;
  const dirty = !!sites && !same(currentSites, baselineSites);
  const removedSites = baselineSites.filter((site) => site.id && !currentSites.some((current) => current.id === site.id));
  const affectedSiteHosts = removedSites.reduce((count, site) => count + (hosts ?? []).filter((host) => host.siteId === site.id).length, 0);
  const invalid = currentSites.some((site) => !site.name.trim());

  const discard = () => setSiteDraft(null);

  const save = async (allowDeletes = false): Promise<boolean> => {
    if (!sites) return false;
    if (invalid) {
      toast.error('Renseigne un nom pour chaque site avant de continuer.');
      return false;
    }
    if (!allowDeletes && removedSites.length > 0) {
      setConfirmDeletes(true);
      return false;
    }
    setSaving(true);
    try {
      if (!same(currentSites, baselineSites)) {
        const result = await api.saveSites(currentSites);
        qc.setQueryData<{ sites: SiteConfig[] }>(keys.sites, { sites: result.sites });
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.sites }),
        qc.invalidateQueries({ queryKey: keys.hosts }),
      ]);
      discard();
      setConfirmDeletes(false);
      toast.success('Sites enregistrés');
      return true;
    } catch (err) {
      toast.error(`Enregistrement des sites échoué : ${(err as Error).message}`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.sites }),
        qc.invalidateQueries({ queryKey: keys.hosts }),
      ]);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const markSaved = useSettingsDraft(dirty, () => save(), discard);
  if (!sites) return <div className="flex justify-center p-10"><Spinner /></div>;

  const countSiteHosts = (id?: string) => id ? (hosts ?? []).filter((host) => host.siteId === id).length : 0;

  return (
    <Panel title="Sites" icon={MapPin}>
      <div className="space-y-5 text-sm">
        <p className="text-muted">
          Chaque hôte peut appartenir à un site. Le tableau de bord les affiche dans cet ordre ; choisis aussi une couleur, mise en évidence sur la fiche de l’hôte.
          Les modifications restent en brouillon jusqu’à « Enregistrer ».
        </p>
        {currentSites.length === 0 && <p className="text-xs text-muted">Aucun site configuré.</p>}
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
        <Button size="sm" icon={Plus} disabled={saving} onClick={() => setSiteDraft([...currentSites, { name: '', kind: currentSites.length ? 'vpn' : 'main', color: 'blue' }])}>
          Ajouter un site
        </Button>
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
        <p>{removedSites.length} site(s) supprimé(s), ce qui détachera {affectedSiteHosts} hôte(s).</p>
        <p className="mt-2">Les autres modifications seront également enregistrées.</p>
      </ConfirmModal>
    </Panel>
  );
}
