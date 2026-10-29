import clsx from 'clsx';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronLeft, PanelRightClose, PanelRightOpen, X, type LucideIcon } from 'lucide-react';

const WIDE = '(min-width: 2200px)';
const KEY = 'aside-docked';

function subscribe(cb: () => void) {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener('change', cb);
  window.addEventListener('storage', cb);
  return () => { mq.removeEventListener('change', cb); window.removeEventListener('storage', cb); };
}

function read(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* storage unavailable: fall back to the width */ }
  return window.matchMedia(WIDE).matches;
}

// Docked (column in the layout) or floating (tab + drawer). Default by width (>= 2200px: docked), overridable
// by the user and remembered in this browser.
export function useAsideDocked(): [boolean, (docked: boolean) => void] {
  const docked = useSyncExternalStore(subscribe, read);
  const set = (v: boolean) => {
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* ignore */ }
    window.dispatchEvent(new Event('storage'));
  };
  return [docked, set];
}

// Right-hand column of a page: docked in the layout, or hidden behind a tab on the right edge of the window and
// slid over the page on click. Same children in both modes.
export function FloatingAside({ label, icon: Icon, docked, onDock, dockedClassName, openKey, children }: {
  label: string;
  icon: LucideIcon;
  docked: boolean;
  onDock: (docked: boolean) => void;
  dockedClassName?: string;
  // opens the drawer when it changes to a non-null value (e.g. a job just started)
  openKey?: unknown;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (openKey) setOpen(true);
  }, [openKey]);

  useEffect(() => {
    if (!open || docked) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, docked]);

  const btn = 'flex items-center gap-1.5 text-xs text-muted hover:text-zinc-100';

  if (docked) {
    return (
      <aside className={clsx('flex min-w-0 flex-col gap-4', dockedClassName)}>
        <button type="button" onClick={() => onDock(false)} className={clsx(btn, 'ml-auto')} title="Passer en panneau flottant">
          <PanelRightClose className="h-4 w-4" /> Détacher
        </button>
        {children}
      </aside>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        className={clsx('fixed right-0 top-1/3 z-20 flex flex-col items-center gap-2 rounded-l-lg border border-r-0 border-line bg-panel px-1.5 py-3 text-muted shadow-lg hover:text-zinc-100', open && 'invisible')}
      >
        <ChevronLeft className="h-4 w-4" />
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium [writing-mode:vertical-rl]">{label}</span>
      </button>

      {open && <div className="fixed inset-0 top-14 z-30 bg-black/60" onClick={() => setOpen(false)} />}

      <aside
        className={clsx(
          'fixed bottom-0 right-0 top-14 z-30 flex w-[420px] max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg p-4 shadow-2xl transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => onDock(true)} className={btn} title="Ancrer dans la page">
            <PanelRightOpen className="h-4 w-4" /> Ancrer
          </button>
          <button type="button" onClick={() => setOpen(false)} aria-label="Fermer" className="text-muted hover:text-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}
