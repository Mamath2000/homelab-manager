import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Save, Server, Settings2, Terminal, User, UserCog, Wand2, type LucideIcon } from 'lucide-react';
import { api, type SetupOption, type SetupProfile, type SetupValues } from '../lib/api';
import { setupOptionInfo, setupSections, type SetupSection } from '../lib/setup';
import { useToast } from '../lib/toast';
import { OptionEditor, OptionNotes, textarea } from './SetupFields';
import { Button, Panel, Spinner } from './ui';

type Tab = 'general' | SetupSection | 'starship' | 'fastfetch';
const sectionIcons: Record<SetupSection, LucideIcon> = { system: Server, root: UserCog, user: User };

// Standard configuration of the hosts (Paramètres > Standardisation), in vertical tabs: general, the
// three sections (system, root, an optional user) and the Starship / fastfetch configurations. Checked options are applied to the hosts and checked for conformity;
// each host can override them (fiche de l'hôte > Standardisation).
export function SetupSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'setup'], queryFn: api.setupProfile });
  // local draft once edited, server values until then
  const [draft, setForm] = useState<SetupProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('general');

  const form = draft ?? data;
  if (!form) return <div className="flex justify-center p-10"><Spinner /></div>;
  const opts = form.options;
  const setOption = <K extends SetupOption>(k: K, patch: Partial<{ enabled: boolean; value: SetupValues[K] }>) =>
    setForm({ ...form, options: { ...opts, [k]: { ...opts[k], ...patch } } });
  // a style used by root, or by the user when there is one
  const used = (k: 'root_motd' | 'user_motd' | 'root_prompt' | 'user_prompt', style: string) =>
    opts[k].enabled && opts[k].value === style && (k.startsWith('root') || opts.user.enabled);
  const fastfetchUsed = used('root_motd', 'fastfetch') || used('user_motd', 'fastfetch');
  const starshipUsed = used('root_prompt', 'starship') || used('user_prompt', 'starship');

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.saveSetupProfile(form);
      qc.setQueryData(['settings', 'setup'], next);
      qc.invalidateQueries({ queryKey: ['setup'] });
      setForm(null);
      toast.success('Configuration standard enregistrée : conformité des hôtes en cours de vérification');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (k: SetupOption) => {
    const o = opts[k];
    return (
      <div key={k} className={`rounded-md border p-4 ${o.enabled ? 'border-emerald-500/30 bg-emerald-500/[0.03]' : 'border-line bg-raised/20'}`}>
        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={o.enabled} onChange={(e) => setOption(k, { enabled: e.target.checked })} className="mt-0.5 h-4 w-4 accent-emerald-500" />
          <span>
            <span className="block font-medium text-zinc-100">{setupOptionInfo[k].label}</span>
            <span className="mt-0.5 block text-xs text-muted">{setupOptionInfo[k].hint}</span>
          </span>
        </label>
        {o.enabled && (
          <div className="mt-3 pl-7">
            <OptionEditor option={k} value={o.value} onChange={(value) => setOption(k, { value })} />
            <OptionNotes option={k} value={o.value} />
          </div>
        )}
      </div>
    );
  };

  const tabs: { id: Tab; label: string; icon: LucideIcon; count?: string }[] = [
    { id: 'general', label: 'Général', icon: Settings2 },
    ...setupSections.map((sec) => ({
      id: sec.id,
      label: sec.title,
      icon: sectionIcons[sec.id],
      count: sec.id === 'user' && !opts.user.enabled ? 'aucun' : `${sec.options.filter((k) => opts[k].enabled).length}/${sec.options.length}`,
    })),
    ...(starshipUsed ? [{ id: 'starship' as const, label: 'Starship', icon: Terminal }] : []),
    ...(fastfetchUsed ? [{ id: 'fastfetch' as const, label: 'fastfetch', icon: Monitor }] : []),
  ];
  // a configuration tab disappears when its style is no longer used
  const current = tabs.some((t) => t.id === tab) ? tab : 'general';
  const section = setupSections.find((sec) => sec.id === current);

  return (
    <Panel title="Configuration standard" icon={Wand2} bodyClassName="" actions={<Button size="sm" variant="primary" icon={Save} loading={busy} onClick={save}>Enregistrer</Button>}>
      <div className="flex flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 md:w-52 md:flex-col md:border-r md:border-b-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap ${current === t.id ? 'bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30' : 'text-muted hover:bg-raised hover:text-zinc-200'}`}
            >
              <t.icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{t.label}</span>
              {t.count && <span className="text-xs tabular-nums text-zinc-500">{t.count}</span>}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-3 p-4 text-sm">
          {current === 'general' && (
            <>
              <p className="text-muted">
                Les options cochées forment la configuration standard : elles sont appliquées aux hôtes et leur conformité est vérifiée par rapport à elles.
                Chaque hôte peut garder la valeur standard, la remplacer ou ne pas gérer l'option. Les agents ne reçoivent que des valeurs, jamais de commandes.
                Disponible sur Debian et Ubuntu.
              </p>
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line bg-raised/40 p-4">
                <input type="checkbox" checked={form.autoApply} onChange={(e) => setForm({ ...form, autoApply: e.target.checked })} className="mt-0.5 h-4 w-4 accent-emerald-500" />
                <span>
                  <span className="block font-medium text-zinc-100">Appliquer à l'ajout d'un hôte</span>
                  <span className="mt-1 block text-xs text-muted">Dès sa première connexion, un nouvel hôte reçoit la configuration standard. Les hôtes existants ne sont pas touchés.</span>
                </span>
              </label>
            </>
          )}

          {section && (
            <>
              <h3 className="text-base font-medium text-zinc-100">{section.title}</h3>
              <p className="text-xs text-muted">{section.hint}</p>
              {section.id === 'user' ? (
                <>
                  {row('user')}
                  {opts.user.enabled ? section.options.filter((k) => k !== 'user').map(row) : <p className="text-xs text-muted">Aucun utilisateur : seul root est configuré.</p>}
                </>
              ) : (
                section.options.map(row)
              )}
            </>
          )}

          {current === 'starship' && (
            <label className="block">
              <h3 className="mb-1 text-base font-medium text-zinc-100">Configuration Starship</h3>
              <span className="mb-2 block text-xs text-muted">
                TOML commun à root et à l'utilisateur, écrit dans /etc/homelab/starship.toml (STARSHIP_CONFIG) ; un ~/.config/starship.toml présent sur l'hôte
                est ignoré. Vide : configuration par défaut de Starship.
              </span>
              <textarea className={`${textarea} min-h-[16rem]`} value={form.starship} onChange={(e) => setForm({ ...form, starship: e.target.value })} spellCheck={false} />
            </label>
          )}

          {current === 'fastfetch' && (
            <label className="block">
              <h3 className="mb-1 text-base font-medium text-zinc-100">Configuration fastfetch</h3>
              <span className="mb-2 block text-xs text-muted">
                JSON commun à root et à l'utilisateur, écrit dans /etc/homelab/fastfetch.jsonc. Une ligne <code>command</code> dont la commande échoue ou
                n'affiche rien est masquée.
              </span>
              <textarea className={`${textarea} min-h-[24rem]`} value={form.fastfetch} onChange={(e) => setForm({ ...form, fastfetch: e.target.value })} spellCheck={false} />
            </label>
          )}
        </div>
      </div>
    </Panel>
  );
}
