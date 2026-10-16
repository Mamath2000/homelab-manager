import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUpsReport, upsAlert, type UpsReport } from '../src/ups.js';

const ups = (o: Partial<UpsReport> = {}): UpsReport => ({
  checkedAt: 1,
  name: 'ups',
  model: 'Back-UPS XS 1400U',
  driver: 'usbhid-ups',
  status: 'OL',
  charge: 100,
  chargeWarning: 50,
  runtime: 528,
  runtimeLow: 120,
  ...o,
});

test('UPS: valid report shape', () => {
  assert.ok(isUpsReport(ups()));
  assert.ok(!isUpsReport(ups({ status: '' })));
  assert.ok(!isUpsReport({ ...ups(), charge: '100' }));
  assert.ok(!isUpsReport(null));
});

test('UPS alert: nothing without a UPS, ok when healthy', () => {
  assert.equal(upsAlert({}), null);
  assert.deepEqual(upsAlert({ ups: ups() }), { level: 'ok', reasons: [] });
});

test('UPS alert: replace battery and alarm are alerts', () => {
  assert.deepEqual(upsAlert({ ups: ups({ status: 'ALARM OL RB' }) }), { level: 'alert', reasons: ['Batterie à remplacer', 'Onduleur en alarme'] });
});

test('UPS alert: on battery is an alert, low battery too', () => {
  assert.equal(upsAlert({ ups: ups({ status: 'OB DISCHRG' }) })?.level, 'alert');
  assert.deepEqual(upsAlert({ ups: ups({ status: 'OB LB', charge: 20 }) })?.reasons, ['Sur batterie (coupure secteur)', 'Batterie faible']);
});

test('UPS alert: low charge, runtime under the low threshold and failed test are warnings', () => {
  assert.deepEqual(upsAlert({ ups: ups({ status: 'OL CHRG', charge: 30 }) }), { level: 'warn', reasons: ['Charge batterie basse : 30 %'] });
  assert.deepEqual(upsAlert({ ups: ups({ runtime: 90 }) })?.reasons, ['Autonomie sous le seuil bas : 2 min']);
  assert.equal(upsAlert({ ups: ups({ testResult: 'Done and error' }) })?.level, 'warn');
  assert.equal(upsAlert({ ups: ups({ testResult: 'Done and passed' }) })?.level, 'ok');
  assert.equal(upsAlert({ ups: ups({ testResult: 'No test initiated' }) })?.level, 'ok');
});

test('UPS alert: values the UPS does not report raise nothing', () => {
  assert.equal(upsAlert({ ups: { checkedAt: 1, name: 'u', model: '', driver: '', status: 'OL' } })?.level, 'ok');
});
