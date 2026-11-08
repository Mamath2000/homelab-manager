import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fcvTarget } from '../src/db.js';

test('featureCompatibilityVersion raised to the version of the server when it lags', () => {
  assert.equal(fcvTarget('8.0.34', '7.0'), '8.0');
  assert.equal(fcvTarget('7.0.25', '6.0'), '7.0');
  assert.equal(fcvTarget('8.3.13', '8.0'), '8.3');
});

test('featureCompatibilityVersion at the version of the server, or unreadable: nothing to do', () => {
  assert.equal(fcvTarget('8.0.34', '8.0'), null);
  assert.equal(fcvTarget('7.0.25', '7.0'), null);
  assert.equal(fcvTarget('8.0.34', ''), null);
  assert.equal(fcvTarget('', '7.0'), null);
});
