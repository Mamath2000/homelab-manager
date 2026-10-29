import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Suspense, useCallback, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import clsx from 'clsx';
import { Activity, Container, DatabaseBackup, Globe, History, KeyRound, LayoutDashboard, LogOut, Menu, PanelLeftClose, PanelLeftOpen, PackageCheck, Plus, Router, Search, Server, Settings, User, Users, type LucideIcon } from 'lucide-react';
import { HeaderSlotContext } from '../lib/headerSlot';
import { PROFILE_LABELS, useMe } from '../lib/auth';
import { AddHostModal } from './AddHostModal';
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
      { to: '/equipments', label: 'Équipements', icon: Router },
      { to: '/updates', label: 'Mises à jour', icon: PackageCheck },
      { to: '/docker', label: 'Docker', icon: Container },
      { to: '/backups', label: 'Sauvegardes', icon: DatabaseBackup },
      { to: '/health', label: 'Santé', icon: Activity },
      { to: '/probes', label: 'Sondes', icon: Globe },
    ],
  },
  {
    title: 'Historique',
    items: [{ to: '/activity', label: 'Activité', icon: History }],
  },
];

function Logo() {
  return (
    <NavLink to="/" aria-label="Accueil" className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-7 w-7">
        <circle cx="16" cy="16" r="11" fill="none" stroke="#22c55e" strokeWidth="3.5" />
        <circle cx="16" cy="16" r="3.5" fill="#22c55e" />
      </svg>
      <span className="hidden text-lg font-semibold tracking-[0.18em] text-zinc-100 sm:inline">HOMELAB</span>
    </NavLink>
  );
}

const COLLAPSED_KEY = 'sidebar-collapsed';

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggle = () => setCollapsed((v) => {
    try { localStorage.setItem(COLLAPSED_KEY, v ? '0' : '1'); } catch { /* private mode: not remembered */ }
    return !v;
  });
  return [collapsed, toggle] as const;
}

function SideLink({ item, onClick, collapsed }: { item: NavItem; onClick?: () => void; collapsed?: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 rounded-md px-3 py-3 text-sm font-medium transition md:py-2',
          collapsed && 'justify-center',
          isActive ? 'bg-raised text-zinc-50 ring-1 ring-inset ring-line' : 'text-zinc-400 hover:bg-raised/60 hover:text-zinc-100',
        )
      }
    >
      <item.icon className="h-4 w-4 shrink-0" />
      {!collapsed && item.label}
    </NavLink>
  );
}

function Sidebar({ onNavigate, onPassword, onLogout, collapsed, onToggle }: { onNavigate?: () => void; onPassword: () => void; onLogout: () => void; collapsed?: boolean; onToggle?: () => void }) {
  const me = useMe();
  return (
    <nav className={clsx('flex h-full flex-col gap-1', collapsed ? 'p-2' : 'p-4')}>
      {!me.isSuperAdmin && sections.map((s, i) => (
        <div key={i} className="flex flex-col gap-1">
          {s.title && collapsed && i > 0 && <div className="my-1.5 h-px bg-line" />}
          {s.title && !collapsed && (
            <div className="mb-1 mt-3 flex items-center gap-2 px-1 text-[11px] uppercase tracking-wider text-zinc-500">
              <span className="h-px flex-1 bg-line" />
              {s.title}
              <span className="h-px flex-1 bg-line" />
            </div>
          )}
          {s.items.map((item) => (
            <SideLink key={item.to} item={item} onClick={onNavigate} collapsed={collapsed} />
          ))}
        </div>
      ))}
      {me.canAccounts && (
        <div className="mt-auto flex flex-col gap-1 border-t border-line pt-3">
          <SideLink item={{ to: '/accounts', label: 'Comptes', icon: Users }} onClick={onNavigate} collapsed={collapsed} />
        </div>
      )}
      <div className={clsx('flex flex-col gap-2 border-t border-line pt-3', !me.canAccounts && 'mt-auto')}>
        <div className={clsx('flex min-w-0 items-start gap-2 px-3 text-zinc-300', collapsed && 'justify-center px-0')} title={collapsed ? `${me.displayName || me.username} — ${PROFILE_LABELS[me.profile]}` : PROFILE_LABELS[me.profile]}>
          <User className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-sm">{me.displayName || me.username}</span>
              <span className="block truncate text-xs text-muted">{PROFILE_LABELS[me.profile]}</span>
            </span>
          )}
        </div>
        <div className={clsx('flex gap-1', collapsed && 'flex-col')}>
          {!me.isSuperAdmin && (
            <button onClick={() => { onPassword(); onNavigate?.(); }} title="Changer mon mot de passe" className={clsx('flex min-h-10 flex-1 items-center gap-2 rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-raised hover:text-zinc-100 md:min-h-0', collapsed && 'justify-center px-0')}>
              <KeyRound className="h-4 w-4 shrink-0" /> {!collapsed && 'Mot de passe'}
            </button>
          )}
          <button onClick={() => { onLogout(); onNavigate?.(); }} title="Se déconnecter" className={clsx('flex min-h-10 flex-1 items-center gap-2 rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-raised hover:text-zinc-100 md:min-h-0', collapsed && 'justify-center px-0')}>
            <LogOut className="h-4 w-4 shrink-0" /> {!collapsed && 'Déconnexion'}
          </button>
          {onToggle && (
            <button onClick={onToggle} title={collapsed ? 'Déplier le menu' : 'Réduire le menu'} aria-label={collapsed ? 'Déplier le menu' : 'Réduire le menu'} className={clsx('flex min-h-10 items-center justify-center rounded-md px-3 py-2 text-zinc-400 hover:bg-raised hover:text-zinc-100 md:min-h-0', !collapsed && 'shrink-0')}>
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          )}
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

export function Layout({ live, onLogout }: { live: boolean; onLogout: () => void }) {
  const me = useMe();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [addingHost, setAddingHost] = useState(false);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [extraSlot, setExtraSlot] = useState<HTMLElement | null>(null);
  const slots = useMemo(() => ({ title: titleSlot, extra: extraSlot }), [titleSlot, extraSlot])
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const openQuickSwitch = useCallback(() => setQuickSwitchOpen(true), []);
  const closeQuickSwitch = useCallback(() => setQuickSwitchOpen(false), []);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const { pathname } = useLocation();
  // drawer is open for the path it was opened on: any navigation closes it
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const drawer = drawerPath === pathname;
  const setDrawer = (open: boolean) => setDrawerPath(open ? pathname : null);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b sm:gap-4 border-line bg-bg/95 px-4 backdrop-blur-sm md:px-6">
        {me.channel === 'dev' && <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-amber-500" />}
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <button className="inline-flex h-10 w-10 items-center justify-center rounded-sm text-zinc-400 hover:bg-raised lg:hidden" onClick={() => setDrawer(!drawer)} aria-label="Menu">
            <Menu className="h-5 w-5" />
          </button>
          <Logo />
          {me.channel === 'dev' && (
            <span title="Version de développement (CHANNEL=dev)" className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-amber-400">DEV</span>
          )}
        </div>
        <div ref={setTitleSlot} className="flex min-w-0 flex-1 items-center gap-3" />
        {/* centred on the bar: the site of the host, wide screens only (it would cover the title otherwise) */}
        <div ref={setExtraSlot} className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 items-center xl:flex [&>*]:pointer-events-auto" />
        <div className="flex shrink-0 items-center gap-2 text-sm sm:gap-4">
          {me.canManage && !me.isSuperAdmin && (
            <button
              type="button"
              onClick={() => setAddingHost(true)}
              aria-label="Ajouter un hôte"
              title="Ajouter un hôte"
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-line px-2.5 text-xs font-medium text-zinc-300 transition hover:border-emerald-500/50 hover:bg-raised hover:text-emerald-300 md:h-8"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Ajouter</span>
            </button>
          )}
          {!me.isSuperAdmin && (
            <button type="button" onClick={openQuickSwitch} aria-label="Accéder à un hôte" title="Accéder à un hôte (H)" className="inline-flex h-10 w-10 items-center justify-center rounded-sm text-zinc-400 transition hover:bg-raised hover:text-zinc-100 md:hidden">
              <Search className="h-4 w-4" />
            </button>
          )}
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

      <aside className={clsx('fixed bottom-0 left-0 top-14 hidden border-r border-line bg-bg lg:block', collapsed ? 'w-16' : 'w-60')}>
        <Sidebar onPassword={() => setPasswordOpen(true)} onLogout={onLogout} collapsed={collapsed} onToggle={toggleCollapsed} />
      </aside>
      {drawer && (
        <div className="fixed inset-0 top-14 z-20 bg-black/60 lg:hidden" onClick={() => setDrawer(false)}>
          <aside className="h-full w-64 border-r border-line bg-bg" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setDrawer(false)} onPassword={() => setPasswordOpen(true)} onLogout={onLogout} />
          </aside>
        </div>
      )}

      <AddHostModal open={addingHost} onClose={() => setAddingHost(false)} />
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      {!me.isSuperAdmin && <HostQuickSwitch open={quickSwitchOpen} onOpen={openQuickSwitch} onClose={closeQuickSwitch} />}

      <main className={clsx('px-4 py-6 lg:px-8', collapsed ? 'lg:ml-16' : 'lg:ml-60')}>
        <div>
          {/* pages are lazy chunks: the menu stays in place while one loads */}
          <HeaderSlotContext.Provider value={slots}>
            <Suspense fallback={<div className="flex justify-center p-10"><Spinner /></div>}>
              <Outlet />
            </Suspense>
          </HeaderSlotContext.Provider>
        </div>
      </main>
    </div>
  );
}
