import { useQuery } from '@tanstack/react-query';
import { api, type HaHostDetail, type HaSection } from '../lib/api';
import { HA_HOST_SECTIONS, HA_LEVELS } from '../lib/haDetail';
import { HaDetailTable } from './HaDetailTable';
import { Spinner } from './ui';

const onHost = (sections: readonly HaSection[]) => HA_HOST_SECTIONS.filter((s) => sections.includes(s));

// Level of detail of one host or several (group edit) in Home Assistant, same table as Paramètres > Home Assistant:
// the global level (default), « Aucun », a preset or custom, on the sections of a host only.
export function HostHaDetail({ hostIds, value, onChange }: { hostIds: string[]; value: HaHostDetail | null; onChange: (v: HaHostDetail | null) => void }) {
  const { data } = useQuery({ queryKey: ['settings', 'homeassistant'], queryFn: api.homeAssistant });
  const { data: preview } = useQuery({
    queryKey: ['settings', 'homeassistant', 'preview', 'hosts', hostIds, value],
    queryFn: () => api.previewHomeAssistant({ hosts: { ids: hostIds, haDetail: value } }),
    enabled: !!data?.enabled && hostIds.length > 0,
    placeholderData: (prev) => prev,
  });
  if (!data) return <div className="flex justify-center p-6"><Spinner /></div>;

  const global = data.detail.level === 'custom' ? data.detail.sections : data.presets[data.detail.level];
  const globalLabel = data.detail.level === 'custom' ? 'Personnalisé' : HA_LEVELS.find((l) => l.id === data.detail.level)?.label;
  const columns = [
    { id: 'global', label: 'Niveau global', hint: `Réglage de Paramètres > Home Assistant : ${globalLabel}`, sections: onHost(global) },
    { id: 'none', label: 'Aucun', hint: 'Hôte non publié : ni appareil, ni alertes, ni compteurs', sections: null },
    ...HA_LEVELS.map((l) => ({ ...l, sections: onHost(data.presets[l.id]) })),
  ];
  const selected = value === null ? 'global' : typeof value === 'object' ? 'custom' : value;
  const many = hostIds.length > 1;

  return (
    <div className="space-y-3">
      {!data.enabled && <p className="text-xs text-amber-400">Aucun broker défini (Paramètres &gt; Home Assistant) : rien n'est publié pour l'instant.</p>}
      <HaDetailTable
        title={many ? 'Niveau des hôtes' : "Niveau de l'hôte"}
        columns={columns}
        rows={HA_HOST_SECTIONS}
        value={selected}
        custom={typeof value === 'object' && value ? value.sections : []}
        onChange={(id, sections) => onChange(id === 'global' ? null : id === 'custom' ? { level: 'custom', sections } : (id as HaHostDetail))}
      >
        <p className="text-xs text-muted">
          Compteurs et top 5 sont publiés sur Homelab Manager et suivent le niveau global ; l'hôte y compte sauf au niveau « Aucun ».
          {preview && (
            <>
              {' '}{many ? `Pour ces ${hostIds.length} hôtes` : 'Pour cet hôte'} : <span className="text-zinc-200">{preview.entities} entité(s)</span> sur{' '}
              <span className="text-zinc-200">{preview.devices} appareil(s)</span>.
            </>
          )}
        </p>
      </HaDetailTable>
    </div>
  );
}
