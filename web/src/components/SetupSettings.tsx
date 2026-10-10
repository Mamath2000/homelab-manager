import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, Wand2 } from 'lucide-react';
import { api, SETUP_MODULES, type SetupModule, type SetupProfile } from '../lib/api';
import { setupModuleInfo } from '../lib/setup';
import { useToast } from '../lib/toast';
import { Button, Panel, Spinner } from './ui';

function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-md border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`rounded px-3 py-1 text-xs ${value === o.id ? 'bg-emerald-500/15 text-emerald-300' : 'text-muted hover:text-zinc-200'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const textarea = 'input min-h-[7rem] font-mono text-xs leading-relaxed';

// Standard configuration of the hosts (Paramètres > Standardisation): what is pre-checked on the
// host pages, applied to new hosts and checked for conformity.
export function SetupSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['settings', 'setup'], queryFn: api.setupProfile });
  // local drafts once edited, server values until then
  const [draft, setForm] = useState<SetupProfile | null>(null);
  // lists edited as text, one item per line (packages also accept spaces)
  const [packagesDraft, setPackages] = useState<string | null>(null);
  const [keysDraft, setKeys] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const form = draft ?? data;
  if (!form || !data) return <div className="flex justify-center p-10"><Spinner /></div>;
  const packages = packagesDraft ?? data.packages.join(' ');
  const keys = keysDraft ?? data.sshKeys.join('\n');
  const set = (patch: Partial<SetupProfile>) => setForm({ ...form, ...patch });
  const inStandard = (m: SetupModule) => form.modules.includes(m);
  const toggle = (m: SetupModule, on: boolean) => set({ modules: on ? SETUP_MODULES.filter((x) => x === m || form.modules.includes(x)) : form.modules.filter((x) => x !== m) });

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.saveSetupProfile({
        ...form,
        packages: [...new Set(packages.split(/\s+/).filter(Boolean))],
        sshKeys: keys.split('\n').map((k) => k.trim()).filter(Boolean),
      });
      qc.setQueryData(['settings', 'setup'], next);
      qc.invalidateQueries({ queryKey: ['setup'] });
      setForm(null);
      setPackages(null);
      setKeys(null);
      toast.success('Configuration standard enregistrée : conformité des hôtes en cours de vérification');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const params: Partial<Record<SetupModule, ReactNode>> = {
    user: (
      <div className="space-y-2">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Nom (vide : root seulement ; modifiable par hôte)</span>
          <input className="input max-w-xs" value={form.user} onChange={(e) => set({ user: e.target.value.trim() })} placeholder="mamath" spellCheck={false} />
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={form.sudoNoPassword} onChange={(e) => set({ sudoNoPassword: e.target.checked })} />
          sudo sans mot de passe (utile si l'utilisateur se connecte uniquement par clé : le compte créé n'a pas de mot de passe)
        </label>
      </div>
    ),
    apt_proxy: <input className="input max-w-md" value={form.aptProxy} onChange={(e) => set({ aptProxy: e.target.value.trim() })} placeholder="http://192.168.100.8:3142 (vide : aucun proxy)" spellCheck={false} />,
    packages: <textarea className={textarea} value={packages} onChange={(e) => setPackages(e.target.value)} spellCheck={false} placeholder="htop git curl jq" />,
    ssh_keys: <textarea className={textarea} value={keys} onChange={(e) => setKeys(e.target.value)} spellCheck={false} placeholder="ssh-ed25519 AAAA… mamath@pc (une clé publique par ligne)" />,
    ssh_config: <textarea className={textarea} value={form.sshConfig} onChange={(e) => set({ sshConfig: e.target.value })} spellCheck={false} placeholder={'Host pve0\n  HostName 192.168.100.240\n  User root'} />,
    aliases: <textarea className={`${textarea} min-h-[12rem]`} value={form.aliases} onChange={(e) => set({ aliases: e.target.value })} spellCheck={false} />,
    prompt: (
      <Choice
        value={form.prompt}
        onChange={(prompt) => set({ prompt })}
        options={[
          { id: 'classic', label: 'Classique coloré' },
          { id: 'starship', label: 'Starship' },
          { id: 'none', label: 'Aucun' },
        ]}
      />
    ),
    motd: (
      <div className="space-y-2">
        <Choice
          value={form.motd}
          onChange={(motd) => set({ motd })}
          options={[
            { id: 'homelab', label: 'Résumé homelab' },
            { id: 'fastfetch', label: 'fastfetch' },
            { id: 'none', label: 'Aucun' },
          ]}
        />
        {form.motd === 'homelab' && (
          <pre className="overflow-x-auto rounded-md border border-line bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
            {'  '}<b className="text-zinc-100">pve-docker01</b> <span className="text-zinc-500">· Debian GNU/Linux 13 (trixie) · lxc</span>{'\n'}
            {'  '}<span className="text-zinc-500">up</span> 12j 3h 08m  <span className="text-zinc-500">·</span> charge 0.21  <span className="text-zinc-500">·</span> RAM 1.2/4.0 Go  <span className="text-zinc-500">·</span> / 38%{'\n'}
            {'  '}192.168.100.21  <span className="text-zinc-500">·</span> docker 7/8 conteneurs{'\n'}
            {'  '}<span className="text-red-400">3 mise(s) à jour, dont 1 de sécurité</span>
          </pre>
        )}
        {(form.prompt === 'starship' || form.motd === 'fastfetch') && (
          <p className="text-xs text-amber-300">Starship et fastfetch s'installent par APT : Debian 13 ou Ubuntu 24.04 et plus récents.</p>
        )}
      </div>
    ),
    ssh_password: (
      <div className="space-y-2">
        <Choice
          value={form.allowPassword ? 'allow' : 'deny'}
          onChange={(v) => set({ allowPassword: v === 'allow' })}
          options={[
            { id: 'allow', label: 'Autorisée' },
            { id: 'deny', label: 'Interdite (clés seulement)' },
          ]}
        />
        {!form.allowPassword && (
          <p className="text-xs text-amber-300">L'agent refuse d'interdire le mot de passe tant qu'aucune clé SSH n'est installée pour root ou l'utilisateur.</p>
        )}
      </div>
    ),
  };

  return (
    <div className="space-y-4">
      <Panel title="Configuration standard" icon={Wand2} actions={<Button size="sm" variant="primary" icon={Save} loading={busy} onClick={save}>Enregistrer</Button>}>
        <div className="space-y-4 text-sm">
          <p className="text-muted">
            Les options cochées forment la configuration standard : elles sont pré-cochées sur la fiche de chaque hôte, et la conformité des hôtes est vérifiée
            par rapport à elles. Les agents ne reçoivent que des valeurs, jamais de commandes. Disponible sur Debian et Ubuntu.
          </p>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line bg-raised/40 p-4">
            <input type="checkbox" checked={form.autoApply} onChange={(e) => set({ autoApply: e.target.checked })} className="mt-0.5 h-4 w-4 accent-emerald-500" />
            <span>
              <span className="block font-medium text-zinc-100">Appliquer à l'ajout d'un hôte</span>
              <span className="mt-1 block text-xs text-muted">Dès sa première connexion, un nouvel hôte reçoit la configuration standard. Les hôtes existants ne sont pas touchés.</span>
            </span>
          </label>
          <div className="space-y-3">
            {SETUP_MODULES.map((m) => (
              <div key={m} className={`rounded-md border p-4 ${inStandard(m) ? 'border-emerald-500/30 bg-emerald-500/[0.03]' : 'border-line bg-raised/20'}`}>
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" checked={inStandard(m)} onChange={(e) => toggle(m, e.target.checked)} className="mt-0.5 h-4 w-4 accent-emerald-500" />
                  <span>
                    <span className="block font-medium text-zinc-100">{setupModuleInfo[m].label}</span>
                    <span className="mt-0.5 block text-xs text-muted">{setupModuleInfo[m].hint}</span>
                  </span>
                </label>
                {params[m] && <div className="mt-3 pl-7">{params[m]}</div>}
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}
