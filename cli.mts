#!/usr/bin/env node
import {
  applyPolicy,
  attachSurface,
  type DesktopAdapterId,
  enrollHost,
  HostFleetStore,
  type HostLocality,
  type HostSurface,
  powerwashHost,
  rollbackSlot,
  type SessionMode,
  stageAndSwitchSlot,
  type UpdateChannel,
} from './src/host-manager.mts';

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printHelp(): void {
  console.log(`Awesome-OS Host Manager (ChromeOS / Fuchsia / Landscape-grade Fleet Control Plane)

Usage:
  holo-host-manager list [--json]
  holo-host-manager status [--json]
  holo-host-manager enroll <host-id> [--label "..."] [--locality local|remote] [--surface desktop|terminal] [--adapter <id>] [--mode <mode>]
  holo-host-manager policy <host-id> [--adapter <id>] [--mode <mode>] [--channel stable|beta|canary|pinned] [--surface desktop|terminal]
  holo-host-manager update <host-id> --release <tag> [--hash <sha512>]
  holo-host-manager rollback <host-id>
  holo-host-manager powerwash <host-id>
  holo-host-manager attach <host-id> [terminal|desktop] [--json]
`);
}

function main(): void {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const cmd = positional[0] ?? 'list';
  const asJson = Boolean(flags.json);
  const storePath = typeof flags.store === 'string' ? flags.store : undefined;
  const store = new HostFleetStore(storePath);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help) {
    printHelp();
    return;
  }

  let fleet = store.load();

  switch (cmd) {
    case 'list': {
      if (asJson) {
        console.log(JSON.stringify(fleet, null, 2));
        return;
      }
      console.log(`Awesome-OS Host Manager Fleet (${fleet.hosts.length} hosts | ABI ${fleet.abiMagic} | CAS ${fleet.casLayout})\n`);
      console.log('HOST                   LOCALITY  SURFACE   SLOT  ADAPTER             MODE                STATUS');
      console.log('---------------------  --------  --------  ----  ------------------  ------------------  ------');
      for (const h of fleet.hosts) {
        const slot = h.slots[h.activeSlot];
        console.log(
          `${h.id.padEnd(21)}  ${h.locality.padEnd(8)}  ${h.policy.defaultSurface.padEnd(8)}  ${slot.slot}${slot.verified ? '*' : ' '}    ${h.policy.desktopAdapter.padEnd(18)}  ${h.policy.mode.padEnd(18)}  ${h.status}`,
        );
      }
      return;
    }

    case 'status': {
      const localCount = fleet.hosts.filter((h) => h.locality === 'local').length;
      const remoteCount = fleet.hosts.filter((h) => h.locality === 'remote').length;
      const summary = {
        totalHosts: fleet.hosts.length,
        localHosts: localCount,
        remoteHosts: remoteCount,
        verifiedSlots: fleet.hosts.filter((h) => h.slots[h.activeSlot].verified).length,
        abiMagic: fleet.abiMagic,
        casLayout: fleet.casLayout,
        storePath: store.filePath,
      };
      if (asJson) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`[HOST-MANAGER] ${summary.totalHosts} hosts (${summary.localHosts} local, ${summary.remoteHosts} remote) | ${summary.verifiedSlots}/${summary.totalHosts} A/B verified | store=${summary.storePath}`);
      }
      return;
    }

    case 'enroll': {
      const id = positional[1];
      if (!id) throw new Error('Usage: holo-host-manager enroll <host-id>');
      fleet = enrollHost(fleet, {
        id,
        label: typeof flags.label === 'string' ? flags.label : undefined,
        locality: typeof flags.locality === 'string' ? (flags.locality as HostLocality) : undefined,
        surface: typeof flags.surface === 'string' ? (flags.surface as HostSurface) : undefined,
        desktopAdapter: typeof flags.adapter === 'string' ? (flags.adapter as DesktopAdapterId) : undefined,
        mode: typeof flags.mode === 'string' ? (flags.mode as SessionMode) : undefined,
      });
      store.save(fleet);
      const enrolled = fleet.hosts.find((h) => h.id === id);
      if (asJson) console.log(JSON.stringify(enrolled, null, 2));
      else console.log(`[HOST-MANAGER] Enrolled ${id} (${enrolled?.locality}/${enrolled?.policy.defaultSurface} -> ${enrolled?.policy.desktopAdapter})`);
      return;
    }

    case 'policy': {
      const id = positional[1];
      if (!id) throw new Error('Usage: holo-host-manager policy <host-id> [--adapter ...] [--mode ...] [--channel ...]');
      fleet = applyPolicy(fleet, id, {
        ...(typeof flags.adapter === 'string' ? { desktopAdapter: flags.adapter as DesktopAdapterId } : {}),
        ...(typeof flags.mode === 'string' ? { mode: flags.mode as SessionMode } : {}),
        ...(typeof flags.channel === 'string' ? { autoUpdateChannel: flags.channel as UpdateChannel } : {}),
        ...(typeof flags.surface === 'string' ? { defaultSurface: flags.surface as HostSurface } : {}),
      });
      store.save(fleet);
      const updated = fleet.hosts.find((h) => h.id === id);
      if (asJson) console.log(JSON.stringify(updated?.policy, null, 2));
      else console.log(`[HOST-MANAGER] Updated policy for ${id}: mode=${updated?.policy.mode}, adapter=${updated?.policy.desktopAdapter}, channel=${updated?.policy.autoUpdateChannel}`);
      return;
    }

    case 'update': {
      const id = positional[1];
      const release = typeof flags.release === 'string' ? flags.release : '';
      if (!id || !release) throw new Error('Usage: holo-host-manager update <host-id> --release <tag> [--hash <sha512>]');
      const hash = typeof flags.hash === 'string' ? flags.hash : `v11-${release.replace(/[^a-z0-9._-]/gi, '-')}`;
      const res = stageAndSwitchSlot(fleet, id, release, hash);
      store.save(res.fleet);
      if (asJson) console.log(JSON.stringify({ hostId: id, activeSlot: res.targetSlot, release, hash }, null, 2));
      else console.log(`[HOST-MANAGER] Staged & switched ${id} -> Slot ${res.targetSlot} (${release}, verified)`);
      return;
    }

    case 'rollback': {
      const id = positional[1];
      if (!id) throw new Error('Usage: holo-host-manager rollback <host-id>');
      const res = rollbackSlot(fleet, id);
      store.save(res.fleet);
      if (asJson) console.log(JSON.stringify({ hostId: id, activeSlot: res.activeSlot, restoredRelease: res.restoredRelease }, null, 2));
      else console.log(`[HOST-MANAGER] Rolled back ${id} -> Slot ${res.activeSlot} (${res.restoredRelease})`);
      return;
    }

    case 'powerwash': {
      const id = positional[1];
      if (!id) throw new Error('Usage: holo-host-manager powerwash <host-id>');
      fleet = powerwashHost(fleet, id);
      store.save(fleet);
      const washed = fleet.hosts.find((h) => h.id === id);
      if (asJson) console.log(JSON.stringify({ hostId: id, powerwashCount: washed?.powerwashCount }, null, 2));
      else console.log(`[HOST-MANAGER] Powerwashed ${id} (ephemeral state wiped, immutable v11 CAS preserved, count=${washed?.powerwashCount})`);
      return;
    }

    case 'attach': {
      const id = positional[1];
      if (!id) throw new Error('Usage: holo-host-manager attach <host-id> [terminal|desktop]');
      const surface = positional[2] as HostSurface | undefined;
      const att = attachSurface(fleet, id, surface);
      if (asJson) console.log(JSON.stringify(att, null, 2));
      else console.log(`[HOST-MANAGER] ${att.systemUri}\n  cmd: ${att.command}`);
      return;
    }

    default:
      throw new Error(`Unknown command "${cmd}". Run with --help for usage.`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[HOST-MANAGER] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
