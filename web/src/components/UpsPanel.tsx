import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { BatteryCharging, TriangleAlert } from 'lucide-react';
import { api, type UpsCommand, type UpsReport } from '../lib/api';
import { useToast } from '../lib/toast';
import { timeAgo } from '../lib/format';
import { toneText, type Tone } from '../lib/status';
import { Badge, Button, ConfirmModal, Panel } from './ui';

// Failed self-test: same rule as the hub (alerts of the UPS domain).
const testFailed = (t?: string) => !!t && /(error|fail|warning)/i.test(t) && !/passed/i.test(t);

const flags = (status: string) => new Set(status.split(/\s+/).filter(Boolean));

// mm:ss under an hour, h mm above
function runtimeText(s: number) {
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

function Gauge({ pct, tone, mark }: { pct: number; tone: Tone; mark?: number }) {
  const fill: Partial<Record<Tone, string>> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', info: 'bg-sky-500' };
  return (
    <div className="relative h-1.5 overflow-hidden rounded-full bg-line">
      <div className={clsx('absolute inset-y-0 left-0 rounded-full', fill[tone] ?? 'bg-zinc-500')} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      {mark !== undefined && <div className="absolute inset-y-0 w-px bg-zinc-100/50" style={{ left: `${Math.max(0, Math.min(100, mark))}%` }} />}
    </div>
  );
}

function Metric({ label, value, unit, hint, children }: { label: string; value: string | null; unit?: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="font-mono text-xl tabular-nums text-zinc-100">
        {value ?? '—'}
        {value !== null && unit && <small className="ml-0.5 text-xs text-muted">{unit}</small>}
      </span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

const fr = (n: number) => String(n).replace('.', ',');

// UPS of the host (NUT): state, battery health and the usual measures. One UPS per host.
// `canControl`: the agent of the host holds the NUT credentials (capability ups_control).
export function UpsPanel({ hostId, ups, canControl }: { hostId: string; ups: UpsReport; canControl: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<UpsCommand | null>(null);
  const [confirmTest, setConfirmTest] = useState(false);
  const run = async (command: UpsCommand, done: string) => {
    setBusy(command);
    try {
      await api.upsCommand(hostId, command);
      toast.success(done);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
      setConfirmTest(false);
    }
  };
  const f = flags(ups.status);
  const replace = f.has('RB');
  const onBattery = f.has('OB');
  const alarm = f.has('ALARM') || f.has('FSD') || f.has('OVER');
  const lowBattery = f.has('LB');
  const lowCharge = ups.charge !== undefined && ups.chargeWarning !== undefined && ups.charge < ups.chargeWarning;
  const lowRuntime = ups.runtime !== undefined && ups.runtimeLow !== undefined && ups.runtime <= ups.runtimeLow;
  const crit = replace || onBattery || alarm || lowBattery;
  const chargeTone: Tone = lowBattery || (ups.charge !== undefined && ups.chargeLow !== undefined && ups.charge <= ups.chargeLow) ? 'bad' : lowCharge ? 'warn' : 'ok';
  const runtimeTone: Tone = replace || lowBattery || lowRuntime ? 'bad' : 'ok';
  // longest runtime the gauge shows: 30 minutes, which is about the autonomy of a healthy small UPS
  const runtimePct = ups.runtime !== undefined ? (ups.runtime / 1800) * 100 : 0;
  const runtimeMark = ups.runtimeLow !== undefined ? (ups.runtimeLow / 1800) * 100 : undefined;
  const failedTest = testFailed(ups.testResult);

  return (
    <Panel
      title="Onduleur"
      icon={BatteryCharging}
      actions={<span className="text-xs text-muted" title={`driver ${ups.driver}`}>NUT · {timeAgo(ups.checkedAt)}</span>}
      className={clsx(crit && 'border-red-500/50')}
      bodyClassName="flex flex-col gap-4 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-zinc-100">{ups.model || 'Onduleur'}</div>
          <div className="mt-0.5 font-mono text-xs text-muted">
            {ups.name}
            {ups.driver && ` · ${ups.driver}`}
            {ups.mfrDate && ` · batterie fab. ${ups.mfrDate.slice(5, 7)}/${ups.mfrDate.slice(0, 4)}`}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {onBattery ? <Badge tone="bad">Sur batterie</Badge> : f.has('OL') ? <Badge tone="ok">Sur secteur</Badge> : <Badge tone="warn">{ups.status}</Badge>}
          {replace ? <Badge tone="bad">Batterie à remplacer</Badge> : lowBattery ? <Badge tone="bad">Batterie faible</Badge> : <Badge tone="ok">Batterie OK</Badge>}
          {alarm && <Badge tone="bad">Alarme</Badge>}
        </div>
      </div>

      {replace && (
        <div className="flex gap-2.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm leading-relaxed text-zinc-200">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <div>
            <span className="font-semibold text-red-400">Fin de vie de la batterie.</span> L'onduleur signale <code className="font-mono text-xs">RB</code> (Replace Battery)
            {ups.runtime !== undefined && (
              <>
                {' '}
                et n'offre plus que {runtimeText(ups.runtime)} min d'autonomie{ups.load !== undefined && ` à ${fr(ups.load)} % de charge`}
              </>
            )}
            . Remplacer la batterie avant la prochaine coupure.
          </div>
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-x-5 gap-y-4">
        <Metric label="Charge batterie" value={ups.charge !== undefined ? fr(ups.charge) : null} unit="%">
          {ups.charge !== undefined && <Gauge pct={ups.charge} tone={chargeTone} mark={ups.chargeWarning} />}
        </Metric>
        <Metric label="Autonomie restante" value={ups.runtime !== undefined ? runtimeText(ups.runtime) : null} unit={ups.runtime !== undefined && ups.runtime < 3600 ? 'min' : undefined}>
          {ups.runtime !== undefined && <Gauge pct={runtimePct} tone={runtimeTone} mark={runtimeMark} />}
        </Metric>
        <Metric label="Charge de l'onduleur" value={ups.load !== undefined ? fr(ups.load) : null} unit="%">
          {ups.load !== undefined && <Gauge pct={ups.load} tone={ups.load >= 80 ? 'warn' : 'info'} />}
        </Metric>
        <Metric label="Tension d'entrée" value={ups.inputVoltage !== undefined ? fr(ups.inputVoltage) : null} unit="V" hint={ups.inputNominal !== undefined ? `nominale ${fr(ups.inputNominal)} V` : undefined} />
        <Metric label="Tension batterie" value={ups.batteryVoltage !== undefined ? fr(ups.batteryVoltage) : null} unit="V" hint={ups.batteryNominal !== undefined ? `nominale ${fr(ups.batteryNominal)} V` : undefined} />
      </div>

      {canControl && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button size="sm" loading={busy === 'beeper.mute'} disabled={!!busy} onClick={() => run('beeper.mute', 'Alarme sonore coupée temporairement')}>
            Couper le bip
          </Button>
          {ups.beeper === 'enabled' ? (
            <Button size="sm" loading={busy === 'beeper.disable'} disabled={!!busy} onClick={() => run('beeper.disable', 'Alarme sonore désactivée')}>
              Désactiver l'alarme
            </Button>
          ) : (
            <Button size="sm" loading={busy === 'beeper.enable'} disabled={!!busy} onClick={() => run('beeper.enable', 'Alarme sonore activée')}>
              Activer l'alarme
            </Button>
          )}
          <Button size="sm" disabled={!!busy} onClick={() => setConfirmTest(true)}>
            Test batterie rapide
          </Button>
        </div>
      )}

      {(ups.testResult || ups.beeper) && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 text-xs text-muted">
          {ups.testResult && (
            <span>
              Dernier auto-test : <span className={clsx('font-mono', failedTest ? toneText.warn : 'text-zinc-200')}>{ups.testResult}</span>
            </span>
          )}
          {ups.beeper && (
            <span>
              Alarme sonore : <span className="font-mono text-zinc-200">{ups.beeper}</span>
            </span>
          )}
        </div>
      )}
    <ConfirmModal
        open={confirmTest}
        onClose={() => setConfirmTest(false)}
        title="Test batterie rapide"
        confirmLabel="Lancer le test"
        danger={replace || lowBattery}
        loading={busy === 'test.battery.start.quick'}
        onConfirm={() => run('test.battery.start.quick', 'Test batterie lancé')}
      >
        L'onduleur bascule brièvement sur batterie pour la tester. Le résultat apparaît dans « Dernier auto-test ».
        {(replace || lowBattery) && ' La batterie est signalée à remplacer : si elle est morte, l\'onduleur peut couper les charges pendant le test.'}
      </ConfirmModal>
    </Panel>
  );
}
