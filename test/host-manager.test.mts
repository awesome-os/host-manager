import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  applyPolicy,
  attachSurface,
  AUDITABLE_DRIVER_SETS,
  createDefaultSeedFleet,
  DEFAULT_V11_DRIVER_CATALOG,
  enrollFromProfile,
  enrollHost,
  HostFleetStore,
  matchModalias,
  powerwashHost,
  resolveDriverPack,
  rollbackSlot,
  stageAndSwitchSlot,
  switchHostDriverSet,
  syncHostDrivers,
  SYSTEM_PROFILES,
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
    assert.equal(rolled.restoredRelease, 'awesome-os/awesome-os@v1.0.0');
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

      const drvOut = execFileSync(
        process.execPath,
        [
          cliPath,
          'drivers',
          'proxmox-01',
          '--modalias',
          'vmbus:f912ad6d,pci:v00001AF4d00001050sv00001AF4,display:webgpu,kvm:switch',
          '--kernel',
          '7.0.0-awesome-v11',
          '--store',
          storePath,
          '--json',
        ],
        { encoding: 'utf8' },
      );
      const drvPack = JSON.parse(drvOut) as {
        kernelRelease: string;
        drivers: Array<{ id: string; tier: string; v11CasTag: string }>;
        savedMb: number;
        v11VerificationTag: string;
      };
      assert.equal(drvPack.kernelRelease, '7.0.0-awesome-v11');
      assert.ok(drvPack.drivers.some((d) => d.id === 'hyperv-keyboard'));
      assert.ok(drvPack.drivers.some((d) => d.id === 'virtio-gpu'));
      assert.ok(drvPack.drivers.some((d) => d.id === 'holo-display-webgpu'));
      assert.ok(drvPack.drivers.some((d) => d.id === 'holo-device-host'));
      assert.ok(drvPack.drivers.some((d) => d.id === 'holo-kvm-switch'));
      assert.ok(drvPack.savedMb > 1490);
      assert.match(drvPack.v11VerificationTag, /^v11:sha512:[0-9a-f]{32}$/);

      const reloaded = store.load();
      const proxmoxHost = reloaded.hosts.find((h) => h.id === 'proxmox-01');
      assert.equal(proxmoxHost?.drivers?.v11VerificationTag, drvPack.v11VerificationTag);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches Linux depmod modalias globs (* and ?) accurately', () => {
    assert.equal(matchModalias('vmbus:*', 'vmbus:f912ad6d-2b17-48ea-bd65-f927a61c7684'), true);
    assert.equal(matchModalias('pci:v00001AF4d00001050*', 'pci:v00001AF4d00001050sv00001AF4sd00001100'), true);
    assert.equal(matchModalias('pci:v00001AF4d00001050*', 'pci:v00001002d0000744C'), false);
    assert.equal(matchModalias('hid:b000?v045E*', 'hid:b0003v045Ep0621'), true);
    assert.equal(matchModalias('hid:b000?v045E*', 'hid:b00033v045Ep0621'), false);
    assert.equal(matchModalias('usb:v*p*d*', 'usb:v1D6Bp0003d0600'), true);
    assert.equal(matchModalias('serio:ty01pr00id*ex*', 'serio:ty01pr00id00ex00'), true);
    assert.equal(matchModalias('exact-match', 'exact-match'), true);
    assert.equal(matchModalias('exact-match', 'exact-match2'), false);
  });

  it('resolves Tier-0/1 .ko and Tier-2 B8G userspace driver packs with SHA-512 v11 CAS tags', () => {
    assert.equal(DEFAULT_V11_DRIVER_CATALOG.length, 12);

    const pack = resolveDriverPack('7.0.0-awesome-v11', [
      'vmbus:f912ad6d',
      'hid:b0003v045E',
      'pci:v00001002d0000744C',
      'pci:v000010ECd00008168',
      'usb:v1D6Bp0003',
      'display:webgpu',
      'kvm:switch',
    ]);

    const ids = pack.drivers.map((d) => d.id);
    assert.deepEqual(ids, [
      'hyperv-keyboard',
      'hid-hyperv',
      'amdgpu',
      'r8169',
      'usbhid',
      'holo-display-webgpu',
      'holo-device-host',
      'holo-kvm-switch',
    ]);
    assert.equal(pack.tierCounts.tier0Boot, 2);
    assert.equal(pack.tierCounts.tier1CasKo, 3);
    assert.equal(pack.tierCounts.tier2Userspace, 3);
    assert.equal(pack.traditionalDistroMb, 1500);
    assert.ok(pack.totalEstimatedKb > 0 && pack.totalEstimatedKb < 2500);
    assert.ok(pack.savedMb > 1495);
    assert.ok(pack.savingsPercent > 99.5);
    assert.match(pack.packSha512, /^[0-9a-f]{128}$/);
    assert.match(pack.v11VerificationTag, /^v11:sha512:[0-9a-f]{32}$/);
    for (const d of pack.drivers) {
      assert.match(d.v11CasTag, /^v11:sha512:[0-9a-f]{24}$/);
    }

    // Deterministic SHA-512 for identical inputs
    const pack2 = resolveDriverPack('7.0.0-awesome-v11', [
      'vmbus:f912ad6d',
      'hid:b0003v045E',
      'pci:v00001002d0000744C',
      'pci:v000010ECd00008168',
      'usb:v1D6Bp0003',
      'display:webgpu',
      'kvm:switch',
    ]);
    assert.equal(pack2.packSha512, pack.packSha512);
  });

  it('syncs resolved v11 driver inventory onto enrolled hosts via syncHostDrivers', () => {
    const fleet = createDefaultSeedFleet('2026-11-26T00:00:00Z');
    const res = syncHostDrivers(
      fleet,
      'local-workstation',
      '7.0.0-awesome-v11',
      ['pci:v00008086d0000A7A0', 'usb:v046DpC52B', 'display:webgpu'],
      DEFAULT_V11_DRIVER_CATALOG,
      '2026-11-26T01:00:00Z',
    );
    assert.deepEqual(
      res.pack.drivers.map((d) => d.id),
      ['i915', 'usbhid', 'holo-display-webgpu'],
    );
    const updated = res.fleet.hosts.find((h) => h.id === 'local-workstation');
    assert.equal(updated?.drivers?.v11VerificationTag, res.pack.v11VerificationTag);
    assert.equal(updated?.lastSeenAt, '2026-11-26T01:00:00Z');
    assert.throws(() => syncHostDrivers(fleet, 'missing-host', '7.0.0-awesome-v11', ['usb:*']));
  });

  it('enrolls hosts from system://profile/* presets and switches auditable system://driver-set/* tracks with A/B rollback', () => {
    assert.ok(SYSTEM_PROFILES.length >= 8);
    assert.ok(AUDITABLE_DRIVER_SETS.length >= 6);

    let fleet = createDefaultSeedFleet();
    const enrolled = enrollFromProfile(fleet, 'dev-laptop-01', 'system://profile/workstation-omarchy');
    assert.equal(enrolled.profile.desktopAdapter, 'omarchy-hyprland');
    fleet = enrolled.fleet;

    const gnome = enrollFromProfile(fleet, 'gnome-box-01', 'system://profile/workstation-gnome');
    assert.equal(gnome.profile.desktopAdapter, 'gnome-wayland');
    assert.ok(gnome.profile.exclude?.includes('tracker-miner-fs'));
    const kde = enrollFromProfile(gnome.fleet, 'kde-box-01', 'system://profile/workstation-kde');
    assert.equal(kde.profile.desktopAdapter, 'kde-plasma');
    assert.ok(kde.profile.exclude?.includes('baloo'));

    const m1 = enrollFromProfile(kde.fleet, 'macbook-m1', 'system://profile/workstation-omarchy-m1');
    assert.equal(m1.profile.defaultDriverSetUri, 'system://driver-set/apple-silicon@pinned-v1');
    const m1Host = m1.fleet.hosts.find((h) => h.id === 'macbook-m1');
    assert.ok(m1Host?.drivers?.drivers.some((d) => d.id === 'apple-avd-video'));
    assert.ok(m1Host?.drivers?.drivers.some((d) => d.id === 'apple-ane-drm'));
    fleet = m1.fleet;

    const switchedProp = switchHostDriverSet(fleet, 'dev-laptop-01', 'system://driver-set/gpu-nvidia@proprietary');
    assert.equal(switchedProp.driverSet.track, 'proprietary');
    assert.equal(switchedProp.targetSlot, 'B');
    fleet = switchedProp.fleet;

    const switchedDev = switchHostDriverSet(fleet, 'dev-laptop-01', 'system://driver-set/gpu-nvidia@driver-dev');
    assert.equal(switchedDev.driverSet.track, 'driver-dev');
    assert.equal(switchedDev.targetSlot, 'A');
    fleet = switchedDev.fleet;

    const rolled = rollbackSlot(fleet, 'dev-laptop-01');
    assert.equal(rolled.activeSlot, 'B');
    assert.equal(rolled.restoredRelease, 'system://driver-set/gpu-nvidia@proprietary');
  });
});
