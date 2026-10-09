import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpCircle, PackageCheck, Search } from 'lucide-react';
import { RebootTag } from '../components/Reboot';
import { useToast } from '../components/Toast';
import { Badge, Button, Checkbox, ConfirmModal, Empty, PageHeader, Spinner } from '../components/ui';
import { api, type Host } from '../lib/api';
import { useHosts } from '../lib/queries';

interface Row {
  name: string;
  security: boolean;
  reboot: boolean;
  candidates: Set<string>;
  hosts: Host[];
}

// Package-centric view: "openssl is outdated on 14 hosts".
export function Updates() {
  const { data: hosts, isLoading } = useHosts();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [securityOnly, setSecurityOnly] = useState(false);
  const [target, setTarget] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    for (const h of hosts ?? []) {
      for (const p of h.apt?.upgradable ?? []) {
        const r = map.get(p.name) ?? { name: p.name, security: false, reboot: false, candidates: new Set(), hosts: [] };
        r.security ||= p.security;
        r.reboot ||= !!p.reboot;
        r.candidates.add(p.candidate);
        r.hosts.push(h);
        map.set(p.name, r);
      }
    }
    return [...map.values()].sort((a, b) => Number(b.security) - Number(a.security) || b.hosts.length - a.hosts.length || a.name.localeCompare(b.name));
  }, [hosts]);

  const list = rows.filter((r) => (!securityOnly || r.security) && r.name.includes(q.toLowerCase()));
  const affected = new Set(rows.flatMap((r) => r.hosts.map((h) => h.id))).size;

  const upgrade = async (row: Row) => {
    setBusy(true);
    const targets = row.hosts.filter((h) => h.online);
    let ok = 0;
    for (const h of targets) {
      try {
        const j = await api.runJob(h.id, 'apt_upgrade', [row.name]);
        if (j.status !== 'failed') ok++;
      } catch {
        // reported below through the counter
      }
    }
    setBusy(false);
    setTarget(null);
    if (ok) toast.success(`${row.name} : mise à jour lancée sur ${ok} hôte(s)`);
    if (ok < targets.length) toast.error(`${targets.length - ok} hôte(s) n'ont pas pu démarrer la mise à jour`);
  };

  if (isLoading || !hosts) return <div className="flex justify-center p-20"><Spinner /></div>;

  return (
    <>
      <PageHeader icon={PackageCheck} title="Mises à jour" />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Paquets distincts', value: rows.length, cls: 'text-amber-400' },
          { label: 'Dont sécurité', value: rows.filter((r) => r.security).length, cls: 'text-red-400' },
          { label: 'Hôtes concernés', value: `${affected} / ${hosts.length}`, cls: 'text-zinc-100' },
        ].map((s) => (
          <div key={s.label} className="panel px-5 py-4">
            <div className={`text-2xl font-semibold tabular-nums ${s.cls}`}>{s.value}</div>
            <div className="mt-1 text-xs text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input h-9 py-0 pl-9" placeholder="Filtrer les paquets" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
          <Checkbox checked={securityOnly} onChange={setSecurityOnly} /> Sécurité uniquement
        </label>
      </div>

      <div className="panel overflow-x-auto">
        {list.length === 0 ? (
          <Empty icon={PackageCheck} title={rows.length ? 'Aucun paquet ne correspond' : 'Tout est à jour'} />
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className="th">Paquet</th>
                <th className="th">Version disponible</th>
                <th className="th">Hôtes</th>
                <th className="th text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((r) => (
                <tr key={r.name} className="hover:bg-raised/40">
                  <td className="td">
                    <span className="font-medium text-zinc-100">{r.name}</span>
                    {r.security && <Badge tone="bad" className="ml-2">sécurité</Badge>}
                    {r.reboot && <RebootTag />}
                  </td>
                  <td className="td font-mono text-xs text-emerald-300">{[...r.candidates].join(', ')}</td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1.5">
                      {r.hosts.map((h) => (
                        <Link key={h.id} to={`/hosts/${h.id}`} className={`rounded px-2 py-0.5 text-xs font-semibold ${h.online ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700' : 'bg-zinc-900 text-zinc-500 line-through'}`}>
                          {h.name}
                        </Link>
                      ))}
                    </div>
                  </td>
                  <td className="td text-right">
                    <Button size="sm" icon={ArrowUpCircle} disabled={!r.hosts.some((h) => h.online)} onClick={() => setTarget(r)}>
                      Mettre à jour ({r.hosts.filter((h) => h.online).length})
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmModal open={!!target} onClose={() => setTarget(null)} title={`Mettre à jour ${target?.name}`} confirmLabel="Lancer" loading={busy} onConfirm={() => target && upgrade(target)}>
        <p>
          <code className="text-zinc-100">apt-get install --only-upgrade {target?.name}</code> sera lancé sur {target?.hosts.filter((h) => h.online).length} hôte(s) en ligne.
        </p>
        {target?.reboot && <p className="mt-2 text-amber-300">Ces hôtes devront ensuite être redémarrés.</p>}
        {target?.hosts.some((h) => !h.online) && <p className="mt-2 text-xs text-muted">Les hôtes hors ligne sont ignorés.</p>}
      </ConfirmModal>
    </>
  );
}
