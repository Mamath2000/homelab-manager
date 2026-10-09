import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
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

export function PageHeader({ icon: Icon, title, actions, children }: { icon: LucideIcon; title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="panel flex items-center gap-3 px-4 py-2.5">
          <Icon className="h-5 w-5 text-zinc-300" />
          <h1 className="truncate text-xl font-medium text-zinc-100">{title}</h1>
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
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
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

export function Modal({ open, onClose, title, children, footer, wide }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-[12vh] backdrop-blur-xs" onMouseDown={onClose}>
      <div
        className={clsx('panel w-full bg-panel shadow-2xl shadow-black/60', wide ? 'max-w-2xl' : 'max-w-md')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h3 className="text-base font-medium text-zinc-100">{title}</h3>
          <button onClick={onClose} className="rounded-sm p-1 text-muted hover:bg-raised hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
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
