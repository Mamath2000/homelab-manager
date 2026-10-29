import { useEffect, useRef, useState } from 'react';

// True while a row scrolling horizontally has more content past its right edge (to show a fade hint).
export function useScrollMore<T extends HTMLElement>(dep?: unknown) {
  const ref = useRef<T>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    update();
    el.addEventListener('scroll', update);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [dep]);
  return [ref, more] as const;
}
