import { toneStroke, type Tone } from '../lib/status';

export interface Segment {
  tone: Tone;
  value: number;
}

// Donut made of one arc per segment.
export function StatusRing({ segments, size = 104 }: { segments: Segment[]; size?: number }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0);
  const visible = segments.filter((s) => s.value > 0);
  const gap = visible.length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="-rotate-90">
      <circle cx="50" cy="50" r={r} fill="none" stroke="#27272a" strokeWidth="10" />
      {total > 0 &&
        visible.map((s, i) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={i}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke={toneStroke[s.tone]}
              strokeWidth="10"
              strokeDasharray={`${Math.max(len - gap, 0.5)} ${c}`}
              strokeDashoffset={-offset}
              className="transition-all duration-500"
            />
          );
          offset += len;
          return el;
        })}
    </svg>
  );
}
