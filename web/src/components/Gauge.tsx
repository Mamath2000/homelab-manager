import { toneStroke, type Tone } from '../lib/status';

const ARC = 'M12 60A48 48 0 0 1 108 60';

// Point on the half circle for a 0-100 value (0 = left end, 100 = right end).
function arcPoint(percent: number, radius: number): [number, number] {
  const angle = Math.PI * (1 - percent / 100);
  return [60 + radius * Math.cos(angle), 60 - radius * Math.sin(angle)];
}

function Tick({ at, tone }: { at: number; tone: Tone }) {
  const [x1, y1] = arcPoint(at, 40);
  const [x2, y2] = arcPoint(at, 56);
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={toneStroke[tone]} strokeWidth={1.8} />;
}

// Half-circle gauge with the warning and alert thresholds as ticks. The arc turns amber or red past a threshold.
export function Gauge({ value, base, warning, alert, label }: { value: number; base: Tone; warning?: number; alert?: number; label: string }) {
  const tone: Tone = alert !== undefined && value >= alert ? 'bad' : warning !== undefined && value >= warning ? 'warn' : base;
  const percent = Math.min(100, Math.max(0, value));
  return (
    <svg viewBox="0 0 120 70" role="img" aria-label={`${label} ${value.toFixed(1)} %`} className="mx-auto block h-auto w-full max-w-40">
      <path d={ARC} pathLength={100} fill="none" strokeWidth={9} className="stroke-white/10" />
      <path d={ARC} pathLength={100} fill="none" strokeWidth={9} stroke={toneStroke[tone]} strokeDasharray={`${percent} 100`} />
      {warning !== undefined && <Tick at={warning} tone="warn" />}
      {alert !== undefined && <Tick at={alert} tone="bad" />}
      <text x={60} y={58} textAnchor="middle" fontSize={15} className="fill-zinc-100 font-mono font-semibold">{value.toFixed(1)} %</text>
    </svg>
  );
}
