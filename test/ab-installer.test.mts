import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildGptAbPlan,
  ESP_SIZE_MIB,
  MIN_DISK_SIZE_GB,
  renderAbLimineConfig,
  SLOT_A_SIZE_MIB,
  SLOT_B_SIZE_MIB,
  switchLimineDefaultSlot,
} from '../src/ab-installer.mts';

describe('awesome-os/host-manager — 1-Click GPT A/B Disk Installer', () => {
  it('builds GPT A/B layout for SATA/virtio devices (/dev/sda) with exact parted, mkfs, and limine.conf', () => {
    const plan = buildGptAbPlan('/dev/sda', 16, 'A');
    assert.equal(plan.schema, 'awesome-os.gpt-ab-plan.v1');
    assert.equal(plan.device, '/dev/sda');
    assert.equal(plan.diskSizeGb, 16);
    assert.equal(plan.activeSlot, 'A');
    assert.equal(plan.defaultEntry, 1);
    assert.equal(plan.requiresYesConfirmation, true);

    assert.equal(plan.partitions.length, 4);
    assert.deepEqual(
      plan.partitions.map((p) => ({
        label: p.label,
        device: p.device,
        fsType: p.fsType,
        sizeMiB: p.sizeMiB,
      })),
      [
        { label: 'ESP', device: '/dev/sda1', fsType: 'fat32', sizeMiB: ESP_SIZE_MIB },
        { label: 'SLOT_A', device: '/dev/sda2', fsType: 'ext4', sizeMiB: SLOT_A_SIZE_MIB },
        { label: 'SLOT_B', device: '/dev/sda3', fsType: 'ext4', sizeMiB: SLOT_B_SIZE_MIB },
        { label: 'AWESOME_V11', device: '/dev/sda4', fsType: 'ext4', sizeMiB: 16 * 1024 - 1281 },
      ],
    );

    assert.deepEqual(plan.partedCommands, [
      'parted -s /dev/sda mklabel gpt',
      'parted -s /dev/sda mkpart ESP fat32 1MiB 257MiB',
      'parted -s /dev/sda set 1 esp on',
      'parted -s /dev/sda mkpart SLOT_A ext4 257MiB 769MiB',
      'parted -s /dev/sda mkpart SLOT_B ext4 769MiB 1281MiB',
      'parted -s /dev/sda mkpart AWESOME_V11 ext4 1281MiB 100%',
    ]);
    assert.deepEqual(plan.mkfsCommands, [
      'mkfs.fat -F 32 -n ESP /dev/sda1',
      'mkfs.ext4 -F -L SLOT_A /dev/sda2',
      'mkfs.ext4 -F -L SLOT_B /dev/sda3',
      'mkfs.ext4 -F -L AWESOME_V11 /dev/sda4',
    ]);
    assert.equal(plan.commands.length, plan.partedCommands.length + plan.mkfsCommands.length);
    assert.match(plan.limineConf, /^default_entry: 1$/m);
    assert.match(plan.limineConf, /\/Awesome-OS Slot A/);
    assert.match(plan.limineConf, /\/Awesome-OS Slot B/);
  });

  it('formats NVMe/MMC partition device paths with "p" suffix and supports activeSlot B', () => {
    const plan = buildGptAbPlan('/dev/nvme0n1', 32, 'B');
    assert.equal(plan.defaultEntry, 2);
    assert.deepEqual(
      plan.partitions.map((p) => p.device),
      ['/dev/nvme0n1p1', '/dev/nvme0n1p2', '/dev/nvme0n1p3', '/dev/nvme0n1p4'],
    );
    assert.ok(plan.mkfsCommands.includes('mkfs.fat -F 32 -n ESP /dev/nvme0n1p1'));
    assert.ok(plan.mkfsCommands.includes('mkfs.ext4 -F -L AWESOME_V11 /dev/nvme0n1p4'));
    assert.match(plan.limineConf, /^default_entry: 2$/m);
  });

  it('enforces strict safety gates on device paths, disk size, and slot IDs', () => {
    assert.throws(() => buildGptAbPlan(''), /Unsafe or invalid block device/);
    assert.throws(() => buildGptAbPlan('sda'), /Unsafe or invalid block device/);
    assert.throws(() => buildGptAbPlan('/tmp/disk.img'), /Unsafe or invalid block device/);
    assert.throws(() => buildGptAbPlan('/dev/sda; rm -rf /'), /Unsafe or invalid block device/);
    assert.throws(() => buildGptAbPlan('/dev/../etc/passwd'), /Unsafe or invalid block device/);
    assert.throws(() => buildGptAbPlan('/dev/sda', MIN_DISK_SIZE_GB - 1), /too small/);
    assert.throws(() => buildGptAbPlan('/dev/sda', 16, 'C' as 'A'), /Invalid A\/B slot/);
    assert.throws(() => renderAbLimineConfig('X' as 'A', 'v1', 'v2'), /Invalid A\/B slot/);
    assert.throws(() => switchLimineDefaultSlot('default_entry: 1\n', 'Z' as 'A'), /Invalid A\/B slot/);
  });

  it('atomically switches limine.conf default_entry between Slot A and Slot B while preserving entries', () => {
    const initial = renderAbLimineConfig('A', 'awesome-os/desktop@v0.4.0', 'awesome-os/desktop@v0.3.0');
    assert.match(initial, /^default_entry: 1$/m);
    assert.ok(initial.includes('/Awesome-OS Slot A (awesome-os/desktop@v0.4.0)'));
    assert.ok(initial.includes('/Awesome-OS Slot B (awesome-os/desktop@v0.3.0)'));

    const switchedB = switchLimineDefaultSlot(initial, 'B');
    assert.match(switchedB, /^default_entry: 2$/m);
    assert.doesNotMatch(switchedB, /^default_entry: 1$/m);
    assert.ok(switchedB.includes('/Awesome-OS Slot A (awesome-os/desktop@v0.4.0)'));
    assert.ok(switchedB.includes('/Awesome-OS Slot B (awesome-os/desktop@v0.3.0)'));

    // O(1) rollback back to Slot A
    const rolledBackA = switchLimineDefaultSlot(switchedB, 'A');
    assert.equal(rolledBackA, initial);

    // Inserts default_entry cleanly if absent from legacy limine.conf
    const legacy = 'timeout: 2\nserial: yes\n\n/Awesome-OS Slot A (v1)\n    protocol: linux\n';
    const patched = switchLimineDefaultSlot(legacy, 'B');
    assert.match(patched, /^default_entry: 2$/m);
    assert.ok(patched.includes('/Awesome-OS Slot A (v1)'));
  });

  it('ships POSIX awesome-install.sh with LF line endings and required CLI flags', () => {
    const scriptPath = join(import.meta.dirname, '..', '..', 'posix', 'scripts', 'awesome-install.sh');
    if (existsSync(scriptPath)) {
      const content = readFileSync(scriptPath, 'utf8');
      assert.ok(content.startsWith('#!/bin/sh\n'), 'awesome-install.sh must start with #!/bin/sh and LF');
      assert.equal(content.includes('\r'), false, 'awesome-install.sh must use pure LF line endings');
      assert.ok(content.includes('--dry-run'));
      assert.ok(content.includes('--target'));
      assert.ok(content.includes('--yes'));
      assert.ok(content.includes('--switch-slot'));
      assert.ok(content.includes('AWESOME_V11'));
    }
  });
});
