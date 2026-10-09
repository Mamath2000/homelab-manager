import { createContext, useContext } from 'react';

export const Ctx = createContext<{ success: (t: string) => void; error: (t: string) => void } | null>(null);

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('ToastProvider missing');
  return ctx;
}
