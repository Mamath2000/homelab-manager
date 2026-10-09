import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorize } from '../src/roles.js';

test('admin may do everything', () => {
  for (const [m, r] of [
    ['DELETE', '/api/users/:id'],
    ['PUT', '/api/settings/agents'],
    ['POST', '/api/hosts/:id/jobs'],
  ]) {
    assert.ok(authorize('admin', m, r), `${m} ${r}`);
  }
});

test('monitor may do everything but accounts', () => {
  assert.ok(authorize('monitor', 'POST', '/api/jobs/bulk'));
  assert.ok(authorize('monitor', 'PUT', '/api/settings/homeassistant'));
  assert.ok(authorize('monitor', 'GET', '/api/settings/agents'));
  assert.ok(!authorize('monitor', 'GET', '/api/users'));
  assert.ok(!authorize('monitor', 'POST', '/api/users'));
  assert.ok(!authorize('monitor', 'POST', '/api/users/:id/reset-password'));
});

test('viewer is read-only and sees neither settings nor accounts', () => {
  assert.ok(authorize('viewer', 'GET', '/api/hosts'));
  assert.ok(authorize('viewer', 'HEAD', '/api/jobs/:id'));
  assert.ok(authorize('viewer', 'GET', '/api/events'));
  assert.ok(authorize('viewer', 'POST', '/api/account/password'));
  assert.ok(!authorize('viewer', 'GET', '/api/settings/homeassistant'));
  assert.ok(!authorize('viewer', 'GET', '/api/users'));
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

test('superadmin may only list accounts and reset passwords', () => {
  assert.ok(authorize('superadmin', 'GET', '/api/users'));
  assert.ok(authorize('superadmin', 'POST', '/api/users/:id/reset-password'));
  for (const [m, r] of [
    ['POST', '/api/users'],
    ['PATCH', '/api/users/:id'],
    ['DELETE', '/api/users/:id'],
    ['GET', '/api/hosts'],
    ['GET', '/api/events'],
    ['POST', '/api/account/password'],
  ]) {
    assert.ok(!authorize('superadmin', m, r), `${m} ${r}`);
  }
});

test('unknown roles get nothing', () => {
  assert.ok(!authorize(undefined as never, 'GET', '/api/hosts'));
});
