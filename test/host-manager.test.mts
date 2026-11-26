import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  applyPolicy,
  attachSurface,
  createDefaultSeedFleet,
  enrollHost,
  HostFleetStore,
  powerwashHost,
  rollbackSlot,
  stageAndSwitchSlot,
} from '../src/host-manager.mts';

describe('awesome-os/host-manager — ChromeOS/Fuchsia Fleet Control Plane', () => {
  it('enrolls local & remote hosts with verified A/B slots and terminal/desktop surfaces', () => {
    let fleet = createDefaultSeedFleet('2026-11-26T00:00:00Z');
    assert.equal(fleet.hosts.length, 4);

    fleet = enrollHost(fleet, {
      id: 'edge-kiosk-07',
      locality: 'remote',
      surface: 'desktop',
      desktopAdapter: 'chonkstep-wayland',
      mode: 'kiosk-app',
    });
    assert.equal(fleet.hosts.length, 5);
    const attDesktop = attachSurface(fleet, 'edge-kiosk-07', 'desktop');
    assert.equal(attDesktop.systemUri, 'system://edge-kiosk-07/desktop/chonkstep-wayland');

    const attTerm = attachSurface(fleet, 'edge-kiosk-07', 'terminal');
    assert.equal(attTerm.systemUri, 'system://edge-kiosk-07/terminal/ttyS0');
  });

  it('supports ChromeOS A/B verified updates, O(1) instant rollback, policy, and 1-click Powerwash', () => {
    let fleet = createDefaultSeedFleet();
    const staged = stageAndSwitchSlot(fleet, 'rack-blade-01', 'awesome-os/desktop@v0.4.0', 'v11-sha512-v040');
    assert.equal(staged.targetSlot, 'B');
    fleet = staged.fleet;

    const rolled = rollbackSlot(fleet, 'rack-blade-01');
    assert.equal(rolled.activeSlot, 'A');
    assert.equal(rolled.restoredRelease, 'awesome-os/desktop@v0.3.0');
    fleet = rolled.fleet;

    fleet = applyPolicy(fleet, 'rack-blade-01', {
      mode: 'kiosk-app',
      autoUpdateChannel: 'beta',
      desktopAdapter: 'noctalia-shell',
    });
    const updated = fleet.hosts.find((h) => h.id === 'rack-blade-01');
    assert.equal(updated?.policy.mode, 'kiosk-app');
    assert.equal(updated?.policy.desktopAdapter, 'noctalia-shell');

    fleet = powerwashHost(fleet, 'rack-blade-01');
    const washed = fleet.hosts.find((h) => h.id === 'rack-blade-01');
    assert.equal(washed?.powerwashCount, 1);
    assert.equal(washed?.policy.mode, 'managed-desktop');
  });

  it('persists fleet atomically and executes CLI end-to-end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awesome-hm-'));
    const storePath = join(dir, 'fleet.json');
    try {
      const store = new HostFleetStore(storePath);
      const seeded = store.load();
      assert.equal(seeded.hosts.length, 4);

      const cliPath = join(import.meta.dirname, '..', 'cli.mts');
      const out = execFileSync(process.execPath, [cliPath, 'enroll', 'proxmox-01', '--locality', 'remote', '--adapter', 'omarchy-hyprland', '--store', storePath, '--json'], {
        encoding: 'utf8',
      });
      const parsed = JSON.parse(out) as { id: string; locality: string };
      assert.equal(parsed.id, 'proxmox-01');
      assert.equal(parsed.locality, 'remote');

      const attachOut = execFileSync(process.execPath, [cliPath, 'attach', 'proxmox-01', 'terminal', '--store', storePath, '--json'], {
        encoding: 'utf8',
      });
      const att = JSON.parse(attachOut) as { systemUri: string };
      assert.equal(att.systemUri, 'system://proxmox-01/terminal/ttyS0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
