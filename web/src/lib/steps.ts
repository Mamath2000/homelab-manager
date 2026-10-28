// Steps of a window done from left to right (the two PBS windows, components/PbsDialog.tsx).
export type StepState = 'done' | 'active' | 'todo';

// States of steps done in order: the first one not done is active, the ones after it wait.
export function stepStates(done: boolean[]): StepState[] {
  const first = done.indexOf(false);
  return done.map((d, i) => (d ? 'done' : i === first ? 'active' : 'todo'));
}
