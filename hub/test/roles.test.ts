import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedBeforePasswordChange, authorize } from '../src/roles.js';

test('admin may do everything', () => {
  for (const [m, r] of [
    ['DELETE', '/api/users/:id'],
    ['PUT', '/api/settings/agents'],
    ['POST', '/api/hosts/:id/jobs'],
  ]) {
    assert.ok(authorize('admin', m, r), `${m} ${r}`);
  }
});

test('operator runs jobs but manages neither hosts, settings nor accounts', () => {
  assert.ok(authorize('operator', 'GET', '/api/hosts'));
  assert.ok(authorize('operator', 'POST', '/api/hosts/:id/jobs'));
  assert.ok(authorize('operator', 'POST', '/api/jobs/bulk'));
  assert.ok(authorize('operator', 'POST', '/api/account/password'));
  assert.ok(authorize('operator', 'GET', '/api/settings/agents'));
  for (const [m, r] of [
    ['POST', '/api/hosts'],
    ['PATCH', '/api/hosts/:id'],
    ['DELETE', '/api/hosts/:id'],
    ['POST', '/api/hosts/:id/token'],
    ['GET', '/api/settings/homeassistant'],
    ['PUT', '/api/settings/agents'],
    ['GET', '/api/users'],
    ['POST', '/api/users'],
  ]) {
    assert.ok(!authorize('operator', m, r), `${m} ${r}`);
  }
});

test('viewer is read-only and sees neither settings nor accounts', () => {
  assert.ok(authorize('viewer', 'GET', '/api/hosts'));
  assert.ok(authorize('viewer', 'HEAD', '/api/jobs/:id'));
  assert.ok(authorize('viewer', 'GET', '/api/events'));
  assert.ok(authorize('viewer', 'POST', '/api/account/password'));
  assert.ok(!authorize('viewer', 'GET', '/api/settings/homeassistant'));
  assert.ok(!authorize('viewer', 'GET', '/api/users'));
  // container logs and compose files may hold secrets
  assert.ok(authorize('viewer', 'GET', '/api/hosts/:id'));
  assert.ok(!authorize('viewer', 'GET', '/api/hosts/:id/stacks/:stack/logs'));
  assert.ok(!authorize('viewer', 'GET', '/api/hosts/:id/stacks/:stack/compose'));
  assert.ok(authorize('operator', 'GET', '/api/hosts/:id/stacks/:stack/logs'));
  assert.ok(!authorize('operator', 'DELETE', '/api/hosts/:id/stacks/:stack'));
  assert.ok(!authorize('operator', 'PUT', '/api/hosts/:id/stacks/:stack/managed'));
  assert.ok(authorize('admin', 'PUT', '/api/hosts/:id/stacks/:stack/managed'));
  for (const [m, r] of [
    ['POST', '/api/hosts'],
    ['PATCH', '/api/hosts/:id'],
    ['DELETE', '/api/hosts/:id'],
    ['POST', '/api/hosts/:id/jobs'],
    ['POST', '/api/jobs/bulk'],
    ['PUT', '/api/settings/agents'],
  ]) {
    assert.ok(!authorize('viewer', m, r), `${m} ${r}`);
  }
});

test('superadmin manages accounts only: list, create, reset', () => {
  assert.ok(authorize('superadmin', 'GET', '/api/users'));
  assert.ok(authorize('superadmin', 'POST', '/api/users'));
  assert.ok(authorize('superadmin', 'POST', '/api/users/:id/reset-password'));
  for (const [m, r] of [
    ['PATCH', '/api/users/:id'],
    ['DELETE', '/api/users/:id'],
    ['GET', '/api/hosts'],
    ['GET', '/api/events'],
    ['POST', '/api/account/password'],
  ]) {
    assert.ok(!authorize('superadmin', m, r), `${m} ${r}`);
  }
});

test('a temporary password only allows changing it', () => {
  assert.ok(allowedBeforePasswordChange('POST', '/api/account/password'));
  assert.ok(!allowedBeforePasswordChange('GET', '/api/hosts'));
  assert.ok(!allowedBeforePasswordChange('GET', '/api/events'));
});

test('unknown roles get nothing', () => {
  assert.ok(!authorize(undefined as never, 'GET', '/api/hosts'));
  assert.ok(!authorize('monitor' as never, 'GET', '/api/hosts'));
});
