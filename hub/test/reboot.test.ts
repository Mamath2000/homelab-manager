import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsReboot } from '../src/reboot.js';

test('kernel, microcode and core userland upgrades need a reboot', () => {
  for (const p of ['linux-image-6.12.48+deb13-amd64', 'proxmox-kernel-6.14.11-2-pve-signed', 'intel-microcode', 'libc6', 'systemd', 'firmware-realtek']) {
    assert.equal(needsReboot(p), true, p);
  }
  for (const p of ['curl', 'libsystemd-shared', 'linux-libc-dev', 'openssl']) {
    assert.equal(needsReboot(p), false, p);
  }
});
