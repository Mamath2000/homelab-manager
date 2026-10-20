import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import clsx from 'clsx';
import { Container, DatabaseBackup, History, KeyRound, LayoutDashboard, LogOut, Menu, PackageCheck, Search, Server, Settings, User, Users, type LucideIcon } from 'lucide-react';
import { ROLE_LABELS, useMe } from '../lib/auth';
import { ChangePasswordModal } from './ChangePasswordModal';
import { HostQuickSwitch } from './HostQuickSwitch';
import { Spinner, StatusDot } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const sections: { title?: string; items: NavItem[] }[] = [
  {
    items: [{ to: '/', label: 'Tableau de bord', icon: LayoutDashboard }],
  },
  {
    title: 'Ressources',
    items: [
      { to: '/hosts', label: 'Hôtes', icon: Server },
      { to: '/updates', label: 'Mises à jour', icon: PackageCheck },
      { to: '/docker', label: 'Docker', icon: Container },
      { to: '/backups', label: 'Sauvegardes', icon: DatabaseBackup },
    ],
  },
  {
    title: 'Historique',
    items: [{ to: '/activity', label: 'Activité', icon: History }],
  },
];

function Logo() {
  return (
    <NavLink to="/" className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-7 w-7">
        <circle cx="16" cy="16" r="11" fill="none" stroke="#22c55e" strokeWidth="3.5" />
        <circle cx="16" cy="16" r="3.5" fill="#22c55e" />
      </svg>
      <span className="text-lg font-semibold tracking-[0.18em] text-zinc-100">HOMELAB</span>
    </NavLink>
  );
}

function SideLink({ item, onClick }: { item: NavItem; onClick?: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onClick}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 rounded-md px-3 py-3 text-sm font-medium transition md:py-2',
          isActive ? 'bg-raised text-zinc-50 ring-1 ring-inset ring-line' : 'text-zinc-400 hover:bg-raised/60 hover:text-zinc-100',
        )
      }
    >
      <item.icon className="h-4 w-4" />
      {item.label}
    </NavLink>
  );
}

function Sidebar({ onNavigate, onPassword, onLogout }: { onNavigate?: () => void; onPassword: () => void; onLogout: () => void }) {
  const me = useMe();
  return (
    <nav className="flex h-full flex-col gap-1 p-4">
      {!me.isSuperAdmin && sections.map((s, i) => (
        <div key={i} className="flex flex-col gap-1">
          {s.title && (
            <div className="mb-1 mt-3 flex items-center gap-2 px-1 text-[11px] uppercase tracking-wider text-zinc-500">
              <span className="h-px flex-1 bg-line" />
              {s.title}
              <span className="h-px flex-1 bg-line" />
            </div>
          )}
          {s.items.map((item) => (
            <SideLink key={item.to} item={item} onClick={onNavigate} />
          ))}
        </div>
      ))}
      {me.canAccounts && (
        <div className="mt-auto flex flex-col gap-1 border-t border-line pt-3">
          <SideLink item={{ to: '/accounts', label: 'Comptes', icon: Users }} onClick={onNavigate} />
        </div>
      )}
      <div className={clsx('flex flex-col gap-2 border-t border-line pt-3', !me.canAccounts && 'mt-auto')}>
        <div className="flex min-w-0 items-start gap-2 px-3 text-zinc-300" title={ROLE_LABELS[me.role]}>
          <User className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block truncate text-sm">{me.displayName || me.username}</span>
            <span className="block truncate text-xs text-muted">{ROLE_LABELS[me.role]}</span>
          </span>
        </div>
        <div className="flex gap-1">
          {!me.isSuperAdmin && (
            <button onClick={() => { onPassword(); onNavigate?.(); }} title="Changer mon mot de passe" className="flex min-h-10 flex-1 items-center gap-2 rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-raised hover:text-zinc-100 md:min-h-0">
              <KeyRound className="h-4 w-4" /> Mot de passe
            </button>
          )}
          <button onClick={() => { onLogout(); onNavigate?.(); }} title="Se déconnecter" className="flex min-h-10 flex-1 items-center gap-2 rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-raised hover:text-zinc-100 md:min-h-0">
            <LogOut className="h-4 w-4" /> Déconnexion
          </button>
        </div>
      </div>
    </nav>
  );
}

// Hub version and the agent version it distributes (what agents are updated to).
function Versions() {
  const { isSuperAdmin } = useMe();
  const { data } = useQuery({ queryKey: ['settings', 'agents'], queryFn: api.agentSettings, staleTime: 60_000, enabled: !isSuperAdmin });
  const agent = data?.binaries.find((b) => b.version)?.version;
  return (
    <span className="hidden items-center gap-3 text-xs text-muted lg:flex">
      <span title="Version du hub">hub v{__APP_VERSION__}</span>
      {agent && <span title="Version de l'agent distribuée par le hub">agent {agent}</span>}
    </span>
  );
}

function SearchBox({ onQuickSwitch }: { onQuickSwitch: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(target.tagName)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <form
        className="relative hidden w-full max-w-md sm:block"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(`/hosts?q=${encodeURIComponent(q)}`);
          setQ('');
          ref.current?.blur();
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un hôte" className="input h-9 py-0 pl-9 pr-10" />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm border border-line bg-panel px-1.5 text-[10px] text-muted">/</kbd>
      </form>
      <button
        type="button"
        onClick={onQuickSwitch}
        aria-label="Rechercher un hôte"
        title="Rechercher un hôte"
        className="inline-flex h-10 w-10 items-center justify-center rounded-sm text-zinc-400 hover:bg-raised hover:text-zinc-100 sm:hidden"
      >
        <Search className="h-5 w-5" />
      </button>
    </>
  );
}

export function Layout({ live, onLogout }: { live: boolean; onLogout: () => void }) {
  const me = useMe();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const openQuickSwitch = useCallback(() => setQuickSwitchOpen(true), []);
  const closeQuickSwitch = useCallback(() => setQuickSwitchOpen(false), []);
  const { pathname } = useLocation();
  // drawer is open for the path it was opened on: any navigation closes it
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const drawer = drawerPath === pathname;
  const setDrawer = (open: boolean) => setDrawerPath(open ? pathname : null);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-line bg-bg/95 px-4 backdrop-blur-sm md:px-6">
        <div className="flex items-center gap-3">
          <button className="inline-flex h-10 w-10 items-center justify-center rounded-sm text-zinc-400 hover:bg-raised lg:hidden" onClick={() => setDrawer(!drawer)} aria-label="Menu">
            <Menu className="h-5 w-5" />
          </button>
          <Logo />
        </div>
        {!me.isSuperAdmin && <SearchBox onQuickSwitch={openQuickSwitch} />}
        <div className="flex items-center gap-4 text-sm">
          <Versions />
          {me.canSettings && (
            <NavLink to="/settings" aria-label="Paramètres" title="Paramètres" className={({ isActive }) => clsx('inline-flex h-10 w-10 items-center justify-center rounded-sm transition hover:bg-raised hover:text-zinc-100 md:h-7 md:w-7', isActive ? 'text-emerald-300' : 'text-zinc-400')}>
              <Settings className="h-4 w-4" />
            </NavLink>
          )}
          {!me.isSuperAdmin && (
            <span title={live ? 'Temps réel connecté' : 'Temps réel déconnecté'} className="flex items-center">
              <StatusDot tone={live ? 'ok' : 'bad'} />
            </span>
          )}
        </div>
      </header>

      <aside className="fixed bottom-0 left-0 top-14 hidden w-60 border-r border-line bg-bg lg:block">
        <Sidebar onPassword={() => setPasswordOpen(true)} onLogout={onLogout} />
      </aside>
      {drawer && (
        <div className="fixed inset-0 top-14 z-20 bg-black/60 lg:hidden" onClick={() => setDrawer(false)}>
          <aside className="h-full w-64 border-r border-line bg-bg" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setDrawer(false)} onPassword={() => setPasswordOpen(true)} onLogout={onLogout} />
          </aside>
        </div>
      )}

      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      {!me.isSuperAdmin && <HostQuickSwitch open={quickSwitchOpen} onOpen={openQuickSwitch} onClose={closeQuickSwitch} />}

      <main className="px-4 py-6 lg:ml-60 lg:px-8">
        <div>
          {/* pages are lazy chunks: the menu stays in place while one loads */}
          <Suspense fallback={<div className="flex justify-center p-10"><Spinner /></div>}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
