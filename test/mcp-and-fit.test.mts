import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detectHardware, recommendProfilesAndModels } from '../src/hardware-fit.mts';
import { handleMcpRequest } from '../src/mcp-server.mts';

describe('@awesome-os/host-manager hardware-fit & stdio MCP', () => {
  it('detects host hardware and recommends fitting OS profiles & LLM engines', () => {
    const hw = detectHardware();
    assert.ok(hw.cpuCores >= 1);
    assert.ok(hw.memoryTotalGb > 0);
    const recs = recommendProfilesAndModels(hw);
    assert.ok(recs.some((r) => r.kind === 'os-profile' && r.id.includes('workstation-omarchy')));
    assert.ok(recs.some((r) => r.kind === 'llm-engine' && r.id.includes('colibri')));
    assert.ok(recs.some((r) => r.kind === 'llm-engine' && r.id.includes('llama.cpp')));
    assert.ok(recs.some((r) => r.kind === 'llm-engine' && r.id.includes('vllm')));
  });

  it('serves JSON-RPC 2.0 MCP initialize, tools/list, and tools/call with structuredContent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awesome-mcp-'));
    const storePath = join(tmp, 'fleet.json');
    try {
      const init = handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, storePath);
      assert.equal(init.id, 1);
      assert.ok((init.result as { serverInfo: { name: string } }).serverInfo.name === 'awesome-os-host-manager');

      const list = handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, storePath);
      const tools = (list.result as { tools: Array<{ name: string }> }).tools;
      assert.ok(tools.some((t) => t.name === 'detect_hardware'));
      assert.ok(tools.some((t) => t.name === 'recommend_profiles'));

      const call = handleMcpRequest(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'detect_hardware', arguments: {} } },
        storePath,
      );
      const res = call.result as { structuredContent: { cpuCores: number } };
      assert.ok(res.structuredContent.cpuCores >= 1);

      const unknown = handleMcpRequest(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'does_not_exist', arguments: {} } },
        storePath,
      );
      assert.equal(unknown.error?.code, -32602);

      const verifyRes = handleMcpRequest(
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'holo_verify',
            arguments: {
              output: 'PASS 16/16 | Authorization: Bearer secret_xyz',
              must_contain: ['PASS 16/16'],
              must_not_contain: ['secret_xyz'],
            },
          },
        },
        storePath,
      );
      const vData = (verifyRes.result as { structuredContent: { verdict: string; redacted: boolean } }).structuredContent;
      assert.equal(vData.verdict, 'PASS');
      assert.equal(vData.redacted, true);

      const compileRes = handleMcpRequest(
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'holo_compile',
            arguments: { symbol_id: 'route_moe', language: 'c-zig-native', source_code: 'int f(){return 1;}', invocations: 2500 },
          },
        },
        storePath,
      );
      const cData = (compileRes.result as { structuredContent: { tier: string; casPath: string } }).structuredContent;
      assert.equal(cData.tier, 'tier2-native-aot');
      assert.ok(cData.casPath.startsWith('cas/v11/files/'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
