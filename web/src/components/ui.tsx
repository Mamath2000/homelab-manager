import { Fragment, useEffect, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { Check, Copy, Loader2, X, type LucideIcon } from 'lucide-react';
import { toneBadge, type Tone } from '../lib/status';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-emerald-600 text-white hover:bg-emerald-500 border-emerald-500/40',
  secondary: 'bg-raised text-zinc-200 hover:bg-zinc-800 border-line',
  ghost: 'bg-transparent text-zinc-300 hover:bg-raised border-transparent',
  danger: 'bg-red-600/90 text-white hover:bg-red-500 border-red-500/40',
};

export function Button({
  variant = 'secondary',
  icon: Icon,
  loading,
  size = 'md',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  icon?: LucideIcon;
  loading?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-md border font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variants[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

// Joined icon-only buttons (actions of a list row): an action not possible stays shown, greyed.
export type IconAction = { icon: LucideIcon; title: string; onClick?: (e: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; loading?: boolean; danger?: boolean };

export function IconGroup({ actions, className }: { actions: IconAction[]; className?: string }) {
  return (
    <span className={clsx('inline-flex divide-x divide-emerald-500/30 overflow-hidden rounded-md border border-emerald-500/40 bg-emerald-500/10', className)}>
      {actions.map(({ icon: Icon, title, onClick, disabled, loading, danger }) => (
        <button
          key={title}
          type="button"
          title={title}
          aria-label={title}
          disabled={disabled || loading}
          onClick={onClick}
          className={clsx(
            'inline-flex h-7 w-8 items-center justify-center text-emerald-300 transition disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent',
            danger ? 'hover:bg-red-500/20 hover:text-red-300' : 'hover:bg-emerald-500/20 hover:text-emerald-100',
          )}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
        </button>
      ))}
    </span>
  );
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        toneBadge[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// Komodo-style label chip (groups, OS, virtualisation...)
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-sm bg-zinc-800/80 px-2 py-0.5 text-xs font-semibold text-zinc-200">
      {children}
    </span>
  );
}

export function PageHeader({ icon: Icon, title, actions, children, titleOverflow = false }: { icon: LucideIcon; title: ReactNode; actions?: ReactNode; children?: ReactNode; titleOverflow?: boolean }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="panel flex items-center gap-3 px-4 py-2.5">
          <Icon className="h-5 w-5 text-zinc-300" />
          <h1 className={clsx('text-xl font-medium text-zinc-100', titleOverflow ? 'overflow-visible' : 'truncate')}>{title}</h1>
        </div>
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, icon: Icon, actions, children, className, bodyClassName }: {
  title?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx('panel min-w-0', className)}>
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            {Icon && <Icon className="h-4 w-4 text-muted" />}
            {title}
          </h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(bodyClassName ?? 'p-4')}>{children}</div>
    </section>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, actions }: {
  tabs: { id: T; label: string; icon?: LucideIcon }[];
  value: T;
  onChange: (id: T) => void;
  actions?: ReactNode; // right of the tabs
}) {
  return (
    <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto border-b border-line pb-2">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={id === value}
          onClick={() => onChange(id)}
          className={clsx(
            'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition',
            id === value ? 'bg-raised text-zinc-50 ring-1 ring-inset ring-line' : 'text-zinc-400 hover:bg-raised/60 hover:text-zinc-100',
          )}
        >
          {Icon && <Icon className="h-4 w-4" />}
          {label}
        </button>
      ))}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">{actions}</div>}
    </div>
  );
}

// Tabs listed on the left of their content (on top below md), each with an optional counter.
export function VerticalTabs<T extends string>({ tabs, value, onChange, children, bodyClassName }: {
  tabs: { id: T; label: string; icon?: LucideIcon; count?: ReactNode; dividerBefore?: boolean }[];
  value: T;
  onChange: (id: T) => void;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <div className="flex flex-col md:flex-row">
      <nav role="tablist" className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 md:w-52 md:flex-col md:border-r md:border-b-0">
        {tabs.map(({ id, label, icon: Icon, count, dividerBefore }) => (
          <Fragment key={id}>
            {dividerBefore && <div aria-hidden="true" className="my-1 h-auto min-h-8 w-px shrink-0 self-stretch bg-line md:my-2 md:h-px md:min-h-0 md:w-auto" />}
            <button
              type="button"
              role="tab"
              aria-selected={id === value}
              onClick={() => onChange(id)}
              className={clsx(
                'flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap',
                id === value ? 'bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30' : 'text-muted hover:bg-raised hover:text-zinc-200',
              )}
            >
              {Icon && <Icon className="h-4 w-4 shrink-0" />}
              <span className="flex-1">{label}</span>
              {count !== undefined && <span className="text-xs tabular-nums text-zinc-500">{count}</span>}
            </button>
          </Fragment>
        ))}
      </nav>
      <div className={clsx('min-w-0 flex-1', bodyClassName ?? 'p-4')}>{children}</div>
    </div>
  );
}

// Indeterminate progress bar: a slider that runs while waiting for an answer of unknown length.
export function ProgressBar({ label, className }: { label?: ReactNode; className?: string }) {
  return (
    <div className={className} role="progressbar" aria-busy="true">
      {label && <p className="mb-2 text-xs text-muted">{label}</p>}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
        <div className="h-full w-2/5 animate-slide rounded-full bg-emerald-500" />
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin text-muted', className)} />;
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon className="h-8 w-8 text-zinc-600" />
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

// open modals, innermost last: Escape closes the one on top only (modals can open from a modal)
const modalStack: symbol[] = [];

export function Modal({ open, onClose, title, children, footer, wide, scroll, low, tall }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  // true: 2xl, 'xl': 5xl (content in columns), 'screen': 5xl at 16:9, the size of the screen (fixed
  // height: switching tabs does not resize it; the body scrolls)
  wide?: boolean | 'xl' | 'screen';
  // long content: the body scrolls inside the window, header and footer stay visible
  scroll?: boolean;
  // lower in the screen (18vh from the top instead of 12vh)
  low?: boolean;
  // 'screen' only: taller than 16:9 (fixed height, up to 44rem) for a window with a lot to show
  tall?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const me = Symbol('modal');
    modalStack.push(me);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && modalStack[modalStack.length - 1] === me && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      modalStack.splice(modalStack.indexOf(me), 1);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-xs" onMouseDown={onClose}
      style={{ paddingTop: low ? '18vh' : '12vh' }}
    >
      <div
        className={clsx(
          'panel w-full bg-panel shadow-2xl shadow-black/60',
          wide === 'xl' || wide === 'screen' ? 'max-w-5xl' : wide ? 'max-w-2xl' : 'max-w-md',
          // 12vh on top, at most 70vh high: the window stays clear of the bottom of the screen
          wide === 'screen' ? (tall ? 'flex h-[min(44rem,calc(82vh_-_2rem))] flex-col' : 'flex aspect-video max-h-[80vh] flex-col') : scroll && 'flex max-h-[70vh] flex-col',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
          <h3 className="text-base font-medium text-zinc-100">{title}</h3>
          <button onClick={onClose} className="rounded-sm p-1 text-muted hover:bg-raised hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className={clsx('px-5 py-4', (scroll || wide === 'screen') && 'min-h-0 flex-1 overflow-y-auto')}>{children}</div>
        {footer && <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmModal({ open, onClose, onConfirm, title, children, confirmLabel, danger, loading }: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      }
    >
      <div className="text-sm text-zinc-300">{children}</div>
    </Modal>
  );
}

export function CopyField({ value, multiline }: { value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // clipboard API needs a secure context; fall back on a hidden textarea for plain http LAN use
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="group relative">
      <pre className={clsx('rounded-md border border-line bg-black/40 py-2.5 pl-3 pr-11 font-mono text-xs text-emerald-300', multiline ? 'whitespace-pre-wrap break-all' : 'overflow-x-auto')}>
        {value}
      </pre>
      <button onClick={copy} title="Copier" className="absolute right-1.5 top-1.5 rounded-sm p-1.5 text-muted hover:bg-raised hover:text-zinc-100">
        {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

export function Checkbox({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate && !checked;
      }}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 cursor-pointer rounded-sm border-line bg-raised accent-emerald-500"
    />
  );
}

export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  const color = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', unknown: 'bg-violet-400', info: 'bg-sky-400', neutral: 'bg-zinc-500' }[tone];
  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
      {pulse && <span className={clsx('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', color)} />}
      <span className={clsx('relative inline-flex h-2.5 w-2.5 rounded-full', color)} />
    </span>
  );
}

// Joined toggle buttons, one pressed (display choice inside a panel).
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <span role="group" aria-label={label} className="inline-flex divide-x divide-line overflow-hidden rounded-md border border-line">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={clsx(
            'h-7 whitespace-nowrap px-2.5 text-xs font-medium transition',
            o.id === value ? 'bg-emerald-500/15 text-emerald-300' : 'bg-raised text-muted hover:text-zinc-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
