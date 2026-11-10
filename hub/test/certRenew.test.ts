import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLIENT_RENEW_BEFORE_DAYS, SERVER_RENEW_BEFORE_DAYS, renewalDue } from '../src/certRenew.js';
import { CLIENT_CERT_DAYS, SERVER_CERT_DAYS } from '../src/pki.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 10);
const at = (days: number) => new Date(now + days * DAY);

test('client certificate: renewed in its last 4 months, kept before', () => {
  assert.equal(renewalDue(at(CLIENT_CERT_DAYS), CLIENT_CERT_DAYS, CLIENT_RENEW_BEFORE_DAYS, now), false);
  assert.equal(renewalDue(at(CLIENT_RENEW_BEFORE_DAYS + 1), CLIENT_CERT_DAYS, CLIENT_RENEW_BEFORE_DAYS, now), false);
  assert.equal(renewalDue(at(CLIENT_RENEW_BEFORE_DAYS - 1), CLIENT_CERT_DAYS, CLIENT_RENEW_BEFORE_DAYS, now), true);
  assert.equal(renewalDue(at(-1), CLIENT_CERT_DAYS, CLIENT_RENEW_BEFORE_DAYS, now), true);
});

test('certificates longer than the current lifetime (5 and 10 years) are renewed at once', () => {
  assert.equal(renewalDue(at(5 * 365 - 30), CLIENT_CERT_DAYS, CLIENT_RENEW_BEFORE_DAYS, now), true);
  assert.equal(renewalDue(at(10 * 365 - 30), SERVER_CERT_DAYS, SERVER_RENEW_BEFORE_DAYS, now), true);
  // a fresh one, with the 5 minutes of clock skew of notBefore, is not
  assert.equal(renewalDue(new Date(now + SERVER_CERT_DAYS * DAY + 5 * 60_000), SERVER_CERT_DAYS, SERVER_RENEW_BEFORE_DAYS, now), false);
});

test('certificate of the agent port: renewed in its last 6 months', () => {
  assert.equal(renewalDue(at(SERVER_RENEW_BEFORE_DAYS + 1), SERVER_CERT_DAYS, SERVER_RENEW_BEFORE_DAYS, now), false);
  assert.equal(renewalDue(at(SERVER_RENEW_BEFORE_DAYS - 1), SERVER_CERT_DAYS, SERVER_RENEW_BEFORE_DAYS, now), true);
});
