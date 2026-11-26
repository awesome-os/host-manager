# Awesome-OS Host Manager (`awesome-os/host-manager`)

ChromeOS Enterprise / Fuchsia `ffx` / Ubuntu Landscape / Apple MDM-grade Fleet & Device Control Plane for **`awesome-os/desktop`** hosts (`local` & `remote` => `terminal` | `desktop`).

## ChromeOS-Inspired Architecture & Usability Patterns

| Pattern | Awesome-OS Host Manager Implementation |
| :--- | :--- |
| **Zero-Touch Enrollment (ZTE)** | 1-click host registration (`holo-host-manager enroll`) or stateless HTTPS iPXE netboot (`https://awesome-os.com/netboot/boot.ipxe`). |
| **Verified A/B Immutable Slots** | Every host tracks `Slot A` and `Slot B` pinned to verified `v11` CAS hashes (`stageAndSwitchSlot`) with **$O(1)$ atomic rollback** (`rollbackSlot`). |
| **1-Click Powerwash** | Wipes mutable session/user state cleanly while keeping the verified immutable `v11` CAS base & host enrollment intact (`powerwashHost`). |
| **Declarative Session Policies** | Switch any host between `managed-desktop`, `kiosk-app`, `terminal-appliance`, and `ephemeral-guest`, pick its desktop UI (`sectium-desktop`, `omarchy-hyprland`, `noctalia-shell`, `chonkstep-wayland`, `kitty-ink-tui`), update channel (`stable`/`beta`/`canary`/`pinned`), and WoL Warm-RAM resume. |
| **Instant Surface Attach** | Jump straight into any `local` or `remote` host's `terminal` (`system://<host>/terminal/ttyS0`) or `desktop` (`system://<host>/desktop/<adapter>`) surface. |

## Quick Start

```powershell
# List all enrolled local & remote hosts
.\bin\holo-host-manager list

# Enroll a new remote bare-metal or Proxmox host
.\bin\holo-host-manager enroll proxmox-01 --locality remote --adapter omarchy-hyprland

# Stage a verified A/B slot update & switch atomically
.\bin\holo-host-manager update proxmox-01 --release awesome-os/desktop@v0.4.0

# Instant O(1) rollback to previous verified slot
.\bin\holo-host-manager rollback proxmox-01

# 1-Click ChromeOS Powerwash
.\bin\holo-host-manager powerwash proxmox-01

# Attach to terminal or desktop surface
.\bin\holo-host-manager attach proxmox-01 terminal
.\bin\holo-host-manager attach proxmox-01 desktop
```

## Web Admin Console

Open **`console/index.html`** locally or live at **`https://awesome-os.com/apps/host-manager.html`**.
