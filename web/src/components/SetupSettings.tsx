import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, Wand2 } from 'lucide-react';
import { api, type SetupOption, type SetupProfile, type SetupValues } from '../lib/api';
import { setupOptionInfo, setupSections } from '../lib/setup';
import { useToast } from '../lib/toast';
import { OptionEditor, OptionNotes, textarea } from './SetupFields';
import { Button, Panel, Spinner } from './ui';

// Standard configuration of the hosts (Paramètres > Standardisation), in three sections: the system,
// root and an optional user. Checked options are applied to the hosts and checked for conformity;
// each host can override them (fiche de l'hôte > Standardisation).
export function SetupSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'setup'], queryFn: api.setupProfile });
  // local draft once edited, server values until then
  const [draft, setForm] = useState<SetupProfile | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="space-y-4">
      <Panel title="Configuration standard" icon={Wand2} actions={<Button size="sm" variant="primary" icon={Save} loading={busy} onClick={save}>Enregistrer</Button>}>
        <div className="space-y-4 text-sm">
          <p className="text-muted">
            Les options cochées forment la configuration standard : elles sont appliquées aux hôtes et leur conformité est vérifiée par rapport à elles. Chaque
            hôte peut garder la valeur standard, la remplacer ou ne pas gérer l'option. Les agents ne reçoivent que des valeurs, jamais de commandes. Disponible
            sur Debian et Ubuntu.
          </p>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line bg-raised/40 p-4">
            <input type="checkbox" checked={form.autoApply} onChange={(e) => setForm({ ...form, autoApply: e.target.checked })} className="mt-0.5 h-4 w-4 accent-emerald-500" />
            <span>
              <span className="block font-medium text-zinc-100">Appliquer à l'ajout d'un hôte</span>
              <span className="mt-1 block text-xs text-muted">Dès sa première connexion, un nouvel hôte reçoit la configuration standard. Les hôtes existants ne sont pas touchés.</span>
            </span>
          </label>
        </div>
      </Panel>

      {setupSections.map((s) => (
        <Panel key={s.id} title={s.title}>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted">{s.hint}</p>
            {s.id === 'user' ? (
              <>
                {row('user')}
                {opts.user.enabled ? s.options.filter((k) => k !== 'user').map(row) : <p className="text-xs text-muted">Aucun utilisateur : seul root est configuré.</p>}
              </>
            ) : (
              s.options.map(row)
            )}
          </div>
        </Panel>
      ))}

      {starshipUsed && (
        <Panel title="Configuration Starship">
          <label className="block text-sm">
            <span className="mb-2 block text-xs text-muted">
              TOML commun à root et à l'utilisateur, écrit dans /etc/homelab/starship.toml (STARSHIP_CONFIG) ; un ~/.config/starship.toml présent sur l'hôte
              est ignoré. Vide : configuration par défaut de Starship.
            </span>
            <textarea className={`${textarea} min-h-[16rem]`} value={form.starship} onChange={(e) => setForm({ ...form, starship: e.target.value })} spellCheck={false} />
          </label>
        </Panel>
      )}

      {fastfetchUsed && (
        <Panel title="Configuration fastfetch">
          <label className="block text-sm">
            <span className="mb-2 block text-xs text-muted">
              JSON commun à root et à l'utilisateur, écrit dans /etc/homelab/fastfetch.jsonc. Une ligne <code>command</code> dont la commande échoue ou n'affiche
              rien est masquée.
            </span>
            <textarea className={`${textarea} min-h-[20rem]`} value={form.fastfetch} onChange={(e) => setForm({ ...form, fastfetch: e.target.value })} spellCheck={false} />
          </label>
        </Panel>
      )}
    </div>
  );
}
