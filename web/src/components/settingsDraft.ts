import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from 'react';

export interface SettingsDraft {
  dirty: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}

interface SettingsDraftScope {
  register: (draft: SettingsDraft | null) => void;
  markSaved: () => void;
}

const SettingsDraftContext = createContext<SettingsDraftScope>({ register: () => {}, markSaved: () => {} });

export function SettingsDraftProvider({
  register,
  onSaved,
  children,
}: {
  register: (draft: SettingsDraft | null) => void;
  onSaved: () => void;
  children: ReactNode;
}) {
  return createElement(SettingsDraftContext.Provider, { value: { register, markSaved: onSaved } }, children);
}

export function useSettingsDraft(dirty: boolean, save: () => Promise<boolean>, discard: () => void) {
  const { register, markSaved } = useContext(SettingsDraftContext);
  const latest = useRef({ dirty, save, discard });
  const controller = useRef<SettingsDraft>({
    dirty,
    save: () => latest.current.save(),
    discard: () => latest.current.discard(),
  });

  useEffect(() => {
    latest.current = { dirty, save, discard };
  }, [dirty, save, discard]);
  useEffect(() => {
    controller.current.dirty = dirty;
    register(controller.current);
    return () => register(null);
  }, [dirty, register]);
  return markSaved;
}
