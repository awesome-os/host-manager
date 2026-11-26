/**
 * @file src/mcp-server.mts
 * @description Zero-dependency stdio JSON-RPC 2.0 Model Context Protocol (MCP) server
 * aligned with Colibri's MCP design (returns both text content + structuredContent).
 */

import { createInterface } from 'node:readline';
import { detectHardware, recommendProfilesAndModels } from './hardware-fit.mts';
import {
  enrollFromProfile,
  HostFleetStore,
  powerwashHost,
  rollbackSlot,
} from './host-manager.mts';
import { AWESOME_WORKSPACES, materializeWorkspace } from './workspaces.mts';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const MCP_TOOLS = [
  {
    name: 'detect_hardware',
    description: 'Probe local CPU, RAM, free disk, platform/arch and return a hardware summary.',
    inputSchema: {
      type: 'object',
      properties: { target_dir: { type: 'string', description: 'Optional directory to check free disk space' } },
    },
  },
  {
    name: 'recommend_profiles',
    description: 'Recommend Awesome-OS workstation profiles and LLM engines (Colibri, llama.cpp, vLLM) that fit this machine.',
    inputSchema: {
      type: 'object',
      properties: { target_dir: { type: 'string' }, include_unfit: { type: 'boolean' } },
    },
  },
  {
    name: 'status',
    description: 'Return fleet summary, active verified A/B slots, ABI magic, and v11 CAS store path.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_fleet',
    description: 'List all enrolled local and remote hosts with surfaces, adapters, and A/B slot state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'enroll_host',
    description: 'Enroll a host from a canonical system://profile/<name> URI.',
    inputSchema: {
      type: 'object',
      required: ['host_id'],
      properties: {
        host_id: { type: 'string' },
        profile: { type: 'string', description: 'e.g. system://profile/workstation-omarchy' },
        label: { type: 'string' },
      },
    },
  },
  {
    name: 'rollback_slot',
    description: 'Perform O(1) verified A/B slot rollback for a host.',
    inputSchema: {
      type: 'object',
      required: ['host_id'],
      properties: { host_id: { type: 'string' } },
    },
  },
  {
    name: 'powerwash_host',
    description: 'Reset user state on a host back to clean verified v11 CAS baseline (1-click Powerwash).',
    inputSchema: {
      type: 'object',
      required: ['host_id'],
      properties: { host_id: { type: 'string' } },
    },
  },
  {
    name: 'list_workspaces',
    description: 'List canonical workspaces:// VS Code / Code-OSS / Antigravity workspace definitions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'materialize_workspace',
    description: 'Write .code-workspace, .vscode/settings.json, and .vscode/mcp.json for a workspaces:// URI.',
    inputSchema: {
      type: 'object',
      required: ['uri', 'out_dir'],
      properties: { uri: { type: 'string' }, out_dir: { type: 'string' } },
    },
  },
] as const;

function toolOk(data: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolErr(message: string) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
  };
}

export function handleMcpRequest(req: JsonRpcRequest, storePath?: string): JsonRpcResponse {
  const id = req.id ?? null;
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'awesome-os-host-manager', version: '0.2.0' },
        capabilities: { tools: {} },
      },
    };
  }

  if (req.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }

  if (req.method === 'tools/call') {
    const params = req.params ?? {};
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const store = new HostFleetStore(storePath);

    try {
      switch (name) {
        case 'detect_hardware': {
          const hw = detectHardware(typeof args.target_dir === 'string' ? args.target_dir : undefined);
          return { jsonrpc: '2.0', id, result: toolOk(hw) };
        }
        case 'recommend_profiles': {
          const hw = detectHardware(typeof args.target_dir === 'string' ? args.target_dir : undefined);
          const all = recommendProfilesAndModels(hw);
          const items = args.include_unfit === false ? all.filter((i) => i.fits) : all;
          return { jsonrpc: '2.0', id, result: toolOk({ hardware: hw, recommendations: items }) };
        }
        case 'status': {
          const fleet = store.load();
          return {
            jsonrpc: '2.0',
            id,
            result: toolOk({
              totalHosts: fleet.hosts.length,
              verifiedSlots: fleet.hosts.filter((h) => h.slots[h.activeSlot].verified).length,
              abiMagic: fleet.abiMagic,
              casLayout: fleet.casLayout,
              storePath: store.filePath,
            }),
          };
        }
        case 'list_fleet': {
          const fleet = store.load();
          return { jsonrpc: '2.0', id, result: toolOk(fleet) };
        }
        case 'enroll_host': {
          const hostId = String(args.host_id ?? '').trim();
          if (!hostId) return { jsonrpc: '2.0', id, result: toolErr('host_id is required') };
          const profile = typeof args.profile === 'string' ? args.profile : 'system://profile/workstation-omarchy';
          const fleet = store.load();
          const host = enrollFromProfile(fleet, {
            id: hostId,
            profileUri: profile,
            label: typeof args.label === 'string' ? args.label : undefined,
          });
          store.save(fleet);
          return { jsonrpc: '2.0', id, result: toolOk(host) };
        }
        case 'rollback_slot': {
          const hostId = String(args.host_id ?? '').trim();
          const fleet = store.load();
          const host = rollbackSlot(fleet, hostId);
          store.save(fleet);
          return { jsonrpc: '2.0', id, result: toolOk(host) };
        }
        case 'powerwash_host': {
          const hostId = String(args.host_id ?? '').trim();
          const fleet = store.load();
          const host = powerwashHost(fleet, hostId);
          store.save(fleet);
          return { jsonrpc: '2.0', id, result: toolOk(host) };
        }
        case 'list_workspaces': {
          return { jsonrpc: '2.0', id, result: toolOk(AWESOME_WORKSPACES) };
        }
        case 'materialize_workspace': {
          const uri = String(args.uri ?? '').trim();
          const outDir = String(args.out_dir ?? '').trim();
          if (!uri || !outDir) return { jsonrpc: '2.0', id, result: toolErr('uri and out_dir are required') };
          return { jsonrpc: '2.0', id, result: toolOk(materializeWorkspace(uri, outDir)) };
        }
        default:
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: toolErr(err instanceof Error ? err.message : String(err)),
      };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } };
}

export function runStdioMcpServer(storePath?: string): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed) as JsonRpcRequest;
      if (req.method === 'notifications/initialized') return;
      const resp = handleMcpRequest(req, storePath);
      process.stdout.write(JSON.stringify(resp) + '\n');
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n',
      );
    }
  });
}
