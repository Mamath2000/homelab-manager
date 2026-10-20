import { createContext } from 'react';

// The elements of the top bar where the current page puts its title (left) and its extra info (right, by the version).
export interface HeaderSlots {
  title: HTMLElement | null;
  extra: HTMLElement | null;
}

export const HeaderSlotContext = createContext<HeaderSlots>({ title: null, extra: null });
