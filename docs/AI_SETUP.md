# Setting up Awesome-OS with an AI Coding Assistant

This guide is written for an AI coding assistant (Antigravity, Claude Code, Codex, Cursor) asked to inspect hardware, recommend a workstation/LLM profile, and enroll or manage Awesome-OS. Every step emits machine-readable JSON.

If your client speaks the Model Context Protocol, use the built-in stdio MCP server instead: see [MCP_SERVER.md](MCP_SERVER.md).

## Ground Rules

- **Ask before downloading large LLM weights** (Colibri MoE models range from 9 GB to 1.56 TB).
- **Reruns are idempotent.** Every `v11` CAS operation is content-addressed by SHA-512.
- **Zero X11 bloat.** Desktop profiles default to Wayland + WebGPU + rootless `Xwayland`.

## 1. Probe Hardware & Fit

```bash
holo-host-manager hardware --json
holo-host-manager recommend --json
```

`recommend --json` returns every `system://profile/*` workstation and LLM engine (`colibri`, `llama.cpp`, `vllm`) with `status` (`good`, `tight`, `needs-ram`, `needs-disk`), `fits`, and `recommended`.

## 2. Enroll & Verify A/B Slot

```bash
holo-host-manager enroll my-workstation --profile system://profile/workstation-omarchy
holo-host-manager status --json
```

## 3. Rollback or Powerwash (O(1))

```bash
holo-host-manager rollback my-workstation
holo-host-manager powerwash my-workstation
```
