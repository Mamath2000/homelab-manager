// User sessions of a Windows host (session_report of the agent, see agent/session_windows.go).

export interface HostSession {
  id: number;
  user: string;
  domain?: string;
  station?: string; // Console, RDP-Tcp#0...
  state: 'active' | 'locked' | 'disconnected';
  logonAt?: number; // unix ms
  // input (keyboard, mouse) in an unlocked session within the last 5 minutes (computed by the agent)
  interactive?: boolean;
  idleSec?: number; // seconds since the last input, at the time of the report
}

export interface SessionReport {
  checkedAt: number; // unix ms
  sessions: HostSession[];
}

const STATES = new Set(['active', 'locked', 'disconnected']);

export function isSessionReport(r: unknown): r is SessionReport {
  const x = r as SessionReport;
  return (
    !!x &&
    typeof x.checkedAt === 'number' &&
    Array.isArray(x.sessions) &&
    x.sessions.length <= 64 &&
    x.sessions.every((s) => !!s && typeof s.id === 'number' && typeof s.user === 'string' && STATES.has(s.state))
  );
}

// What Home Assistant and the UI show: someone logged on, and whether every open session is locked.
export function sessionSummary(r: SessionReport | null | undefined) {
  if (!r) return null;
  const open = r.sessions.filter((s) => s.state !== 'disconnected');
  const users = [...new Set(r.sessions.map((s) => s.user))].sort();
  return {
    users,
    loggedIn: users.length > 0,
    // nobody at the keyboard: no session open, or all of them locked
    locked: open.length > 0 && open.every((s) => s.state === 'locked'),
    // someone is using the computer: input in any session within the agent's idle threshold
    interactive: r.sessions.some((s) => s.interactive === true),
  };
}
