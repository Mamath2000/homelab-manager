import clsx from 'clsx';
import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { HeaderSlotContext } from '../lib/headerSlot';

// Puts the title of the page (and the info next to it) in the slot of the top bar.
export function HeaderTitle({ icon: Icon, title, children, overflow = false, back, status }: { icon: LucideIcon; title: ReactNode; children?: ReactNode; overflow?: boolean; back?: ReactNode; status?: ReactNode }) {
  const slot = useContext(HeaderSlotContext).title;
  if (!slot) return null;
  return createPortal(
    <>
      {back}
      <Icon className="hidden h-5 w-5 shrink-0 text-zinc-300 sm:block" />
      <h1 className={clsx('min-w-0 text-lg font-medium text-zinc-100', overflow ? 'overflow-visible' : 'truncate')}>{title}</h1>
      {status}
      {children && <div className="hidden min-w-0 items-center gap-2 md:flex">{children}</div>}
    </>,
    slot,
  );
}

// Info of the page shown on the right of the top bar, by the version of the hub.
export function HeaderExtra({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlotContext).extra;
  return slot ? createPortal(children, slot) : null;
}
