import { useState } from 'react';
import type { SetupOption, SetupValues } from '../lib/api';
import { motdLabels, promptLabels } from '../lib/setup';

export function Choice<T extends string>({ value, onChange, options, disabled }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; disabled?: boolean }) {
  return (
    <div className="inline-flex flex-wrap rounded-md border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.id)}
          className={`rounded px-3 py-1 text-xs disabled:cursor-default ${value === o.id ? 'bg-emerald-500/15 text-emerald-300' : 'text-muted enabled:hover:text-zinc-200'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const textarea = 'input min-h-[7rem] font-mono text-xs leading-relaxed';

// A list edited as text: packages separated by spaces, keys one per line. The text is kept as typed.
export function ListInput({ value, onChange, lines, placeholder, disabled }: { value: string[]; onChange: (v: string[]) => void; lines?: boolean; placeholder?: string; disabled?: boolean }) {
  const join = (l: string[]) => l.join(lines ? '\n' : ' ');
  const [text, setText] = useState(join(value));
  const parse = (t: string) => [...new Set((lines ? t.split('\n') : t.split(/\s+/)).map((x) => x.trim()).filter(Boolean))];
  return (
    <textarea
      className={textarea}
      value={text}
      disabled={disabled}
      spellCheck={false}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
    />
  );
}

const promptOptions = (['classic', 'starship', 'none'] as const).map((id) => ({ id, label: promptLabels[id] }));
const motdOptions = (['homelab', 'fastfetch', 'none'] as const).map((id) => ({ id, label: motdLabels[id] }));

// Editor of the value of one option (standard configuration or host value).
export function OptionEditor<K extends SetupOption>({ option, value, onChange, disabled }: { option: K; value: SetupValues[K]; onChange: (v: SetupValues[K]) => void; disabled?: boolean }) {
  const set = onChange as (v: unknown) => void;
  switch (option) {
    case 'packages':
      return <ListInput value={value as string[]} onChange={set} placeholder="htop git curl jq" disabled={disabled} />;
    case 'root_keys':
    case 'user_keys':
      return <ListInput value={value as string[]} onChange={set} lines placeholder="ssh-ed25519 AAAA… mamath@pc (une clé publique par ligne)" disabled={disabled} />;
    case 'ssh_password':
      return (
        <Choice
          value={value ? 'allow' : 'deny'}
          onChange={(v) => set(v === 'allow')}
          disabled={disabled}
          options={[
            { id: 'allow', label: 'Autorisée' },
            { id: 'deny', label: 'Interdite (clés seulement)' },
          ]}
        />
      );
    case 'root_aliases':
    case 'user_aliases':
      return <textarea className={`${textarea} min-h-[12rem]`} value={value as string} onChange={(e) => set(e.target.value)} spellCheck={false} disabled={disabled} />;
    case 'root_prompt':
    case 'user_prompt':
      return <Choice value={value as SetupValues['root_prompt']} onChange={set} options={promptOptions} disabled={disabled} />;
    case 'root_motd':
    case 'user_motd':
      return <Choice value={value as SetupValues['root_motd']} onChange={set} options={motdOptions} disabled={disabled} />;
    case 'user': {
      const u = value as SetupValues['user'];
      return (
        <div className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Nom</span>
            <input className="input max-w-xs" value={u.name} onChange={(e) => set({ ...u, name: e.target.value.trim() })} placeholder="mamath" spellCheck={false} disabled={disabled} />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={u.sudoNoPassword} onChange={(e) => set({ ...u, sudoNoPassword: e.target.checked })} disabled={disabled} />
            sudo sans mot de passe (utile si l'utilisateur se connecte uniquement par clé : le compte créé n'a pas de mot de passe)
          </label>
        </div>
      );
    }
  }
  return null;
}

// Notes under a value: preview of the homelab welcome screen, distributions of the APT styles, SSH lock-out.
export function OptionNotes<K extends SetupOption>({ option, value }: { option: K; value: SetupValues[K] }) {
  if ((option === 'root_motd' || option === 'user_motd') && value === 'homelab') {
    return (
      <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
        {'  '}<b className="text-zinc-100">pve-docker01</b> <span className="text-zinc-500">· Debian GNU/Linux 13 (trixie) · lxc</span>{'\n'}
        {'  '}<span className="text-zinc-500">up</span> 12j 3h 08m  <span className="text-zinc-500">·</span> charge 0.21  <span className="text-zinc-500">·</span> RAM 1.2/4.0 Go  <span className="text-zinc-500">·</span> / 38%{'\n'}
        {'  '}192.168.100.21  <span className="text-zinc-500">·</span> docker 7/8 conteneurs{'\n'}
        {'  '}<span className="text-red-400">3 mise(s) à jour, dont 1 de sécurité</span>
      </pre>
    );
  }
  if (value === 'starship' || value === 'fastfetch') {
    return <p className="mt-2 text-xs text-amber-300">{value === 'starship' ? 'Starship' : 'fastfetch'} s'installe par APT : Debian 13 ou Ubuntu 24.04 et plus récents.</p>;
  }
  if (option === 'ssh_password' && value === false) {
    return <p className="mt-2 text-xs text-amber-300">L'agent refuse d'interdire le mot de passe tant qu'aucune clé SSH n'est installée pour root ou l'utilisateur.</p>;
  }
  return null;
}
