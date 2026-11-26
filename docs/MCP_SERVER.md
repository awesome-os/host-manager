# MCP Server: Manage Awesome-OS from Any AI Assistant

`awesome-os/host-manager` ships a zero-dependency stdio JSON-RPC 2.0 [Model Context Protocol](https://modelcontextprotocol.io) server modeled on Colibri's MCP design. Every tool returns both JSON text (`content`) and `structuredContent`.

## Run It

```bash
holo-host-manager mcp
```

## Client Configuration

```json
{
  "mcpServers": {
    "awesome-os": {
      "command": "holo-host-manager",
      "args": ["mcp"]
    }
  }
}
```

## Tools

| Tool | Arguments | Returns |
| :--- | :--- | :--- |
| `detect_hardware` | `target_dir` (optional) | CPU model & cores, total/free RAM, free disk, platform/arch, and summary |
| `recommend_profiles` | `target_dir`, `include_unfit` | Workstation profiles (`system://profile/*`) + LLM engines (`colibri`, `llama.cpp`, `vllm`) with `fits` & `status` |
| `status` | none | Fleet host counts, verified A/B slot counts, ABI magic (`0x33564742`), `v11` store path |
| `list_fleet` | none | Full enrolled fleet state |
| `enroll_host` | `host_id`, `profile`, `label` | Enrolls host from canonical `system://profile/*` URI |
| `rollback_slot` | `host_id` | Performs $O(1)$ verified A/B slot rollback |
| `powerwash_host` | `host_id` | Resets user state back to clean verified `v11` CAS baseline |
