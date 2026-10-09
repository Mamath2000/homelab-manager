import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { History, LayoutDashboard, LogOut, Menu, PackageCheck, Search, Server, Settings, User, type LucideIcon } from 'lucide-react';
import { StatusDot } from './ui';

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
          'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition',
          isActive ? 'bg-raised text-zinc-50 ring-1 ring-inset ring-line' : 'text-zinc-400 hover:bg-raised/60 hover:text-zinc-100',
        )
      }
    >
      <item.icon className="h-4 w-4" />
      {item.label}
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex h-full flex-col gap-1 p-4">
      {sections.map((s, i) => (
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
      <div className="mt-auto border-t border-line pt-3">
        <SideLink item={{ to: '/settings', label: 'Paramètres', icon: Settings }} onClick={onNavigate} />
      </div>
    </nav>
  );
}

function SearchBox() {
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
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-line bg-panel px-1.5 text-[10px] text-muted">/</kbd>
    </form>
  );
}

export function Layout({ user, live, onLogout }: { user: string; live: boolean; onLogout: () => void }) {
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  useEffect(() => setDrawer(false), [location.pathname]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-line bg-bg/95 px-4 backdrop-blur md:px-6">
        <div className="flex items-center gap-3">
          <button className="rounded p-1.5 text-zinc-400 hover:bg-raised md:hidden" onClick={() => setDrawer((d) => !d)} aria-label="Menu">
            <Menu className="h-5 w-5" />
          </button>
          <Logo />
        </div>
        <SearchBox />
        <div className="flex items-center gap-4 text-sm">
          <span className="hidden text-xs text-muted lg:inline">v{__APP_VERSION__}</span>
          <span title={live ? 'Temps réel connecté' : 'Temps réel déconnecté'} className="flex items-center">
            <StatusDot tone={live ? 'ok' : 'bad'} />
          </span>
          <span className="hidden items-center gap-1.5 text-zinc-300 sm:flex">
            <User className="h-4 w-4" />
            {user}
          </span>
          <button onClick={onLogout} title="Se déconnecter" className="rounded p-1.5 text-zinc-400 hover:bg-raised hover:text-zinc-100">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <aside className="fixed bottom-0 left-0 top-14 hidden w-60 border-r border-line bg-bg md:block">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 top-14 z-20 bg-black/60 md:hidden" onClick={() => setDrawer(false)}>
          <aside className="h-full w-64 border-r border-line bg-bg" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <main className="px-4 py-6 md:ml-60 md:px-8">
        <div className="mx-auto max-w-[1600px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
