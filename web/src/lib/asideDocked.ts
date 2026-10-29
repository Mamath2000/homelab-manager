import { useSyncExternalStore } from 'react';

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
