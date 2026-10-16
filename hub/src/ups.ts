import type { DayAlert, HostDoc } from './types.js';

// UPS monitored through NUT on the host (agent ups_report): one UPS per host.
// Numbers are absent when the UPS does not report them.
export interface UpsReport {
  checkedAt: number; // unix ms
  name: string;
  model: string;
  driver: string;
  status: string; // ups.status flags: OL OB LB RB CHRG DISCHRG ALARM...
  charge?: number; // %
  chargeWarning?: number;
  chargeLow?: number;
  runtime?: number; // seconds
  runtimeLow?: number;
  load?: number; // %
  inputVoltage?: number;
  inputNominal?: number;
  batteryVoltage?: number;
  batteryNominal?: number;
  testResult?: string;
  beeper?: string;
  mfrDate?: string;
}

const optNum = (v: unknown) => v === undefined || typeof v === 'number';

export function isUpsReport(r: unknown): r is UpsReport {
  const x = r as UpsReport;
  return (
    !!x &&
    typeof x.checkedAt === 'number' &&
    typeof x.status === 'string' &&
    x.status.length > 0 &&
    [x.charge, x.chargeWarning, x.chargeLow, x.runtime, x.runtimeLow, x.load, x.inputVoltage, x.inputNominal, x.batteryVoltage, x.batteryNominal].every(optNum)
  );
}

export const upsFlags = (status: string) => new Set(status.split(/\s+/).filter(Boolean));

const day = (level: DayAlert['level'], reasons: string[]): DayAlert => ({ level, reasons });

// Failed self-test: NUT texts vary by driver ("Done and passed", "Done and error", "In progress"...).
const testFailed = (t?: string) => !!t && /(error|fail|warning)/i.test(t) && !/passed/i.test(t);

export interface UpsProblem {
  level: 'alert' | 'warn';
  message: string;
}

// What is wrong with the UPS, most serious first; shared by the timeline and Home Assistant.
export function upsProblems(r: UpsReport): UpsProblem[] {
  const f = upsFlags(r.status);
  const out: UpsProblem[] = [];
  const alert = (message: string) => out.push({ level: 'alert', message });
  const warn = (message: string) => out.push({ level: 'warn', message });
  if (f.has('RB')) alert('Batterie à remplacer');
  if (f.has('ALARM')) alert('Onduleur en alarme');
  if (f.has('FSD')) alert('Arrêt forcé en cours');
  if (f.has('OB')) alert('Sur batterie (coupure secteur)');
  if (f.has('LB')) alert('Batterie faible');
  if (f.has('OVER')) alert('Onduleur en surcharge');
  if (!f.has('OL') && !f.has('OB')) warn(`État inhabituel : ${r.status}`);
  if (r.charge !== undefined && r.chargeWarning !== undefined && r.charge < r.chargeWarning && !f.has('OB')) warn(`Charge batterie basse : ${r.charge} %`);
  if (r.runtime !== undefined && r.runtimeLow !== undefined && r.runtime <= r.runtimeLow) warn(`Autonomie sous le seuil bas : ${Math.round(r.runtime / 60)} min`);
  if (testFailed(r.testResult)) warn(`Dernier auto-test : ${r.testResult}`);
  return out;
}

// null: not followed (no UPS reported)
export function upsAlert(h: Pick<HostDoc, 'ups'>): DayAlert | null {
  if (!h.ups) return null;
  const problems = upsProblems(h.ups);
  const reasons = problems.map((p) => p.message);
  return problems.some((p) => p.level === 'alert') ? day('alert', reasons) : reasons.length ? day('warn', reasons) : day('ok', []);
}
