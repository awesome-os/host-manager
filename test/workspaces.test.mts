import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  AWESOME_WORKSPACES,
  materializeWorkspace,
  parseWorkspaceUri,
  resolveWorkspace,
} from '../src/workspaces.mts';

describe('workspaces:// protocol resolver & materializer', () => {
  it('parses and resolves canonical workspaces:// URIs', () => {
    const parsed = parseWorkspaceUri('workspaces://awesome-os/ai-colibri');
    assert.deepEqual(parsed, { org: 'awesome-os', name: 'ai-colibri' });

    const ws = resolveWorkspace('workspaces://awesome-os/ai-colibri');
    assert.equal(ws.name, 'ai-colibri');
    assert.ok(ws.folders.some((f) => f.name === 'colibri'));
    assert.ok(ws.mcpServers.colibri);
    assert.ok(AWESOME_WORKSPACES.length >= 3);

    assert.throws(() => parseWorkspaceUri('https://not-a-workspace'));
  });

  it('materializes .code-workspace, .vscode/settings.json, and .vscode/mcp.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awesome-ws-'));
    try {
      const res = materializeWorkspace('workspaces://awesome-os/os-dev', tmp);
      assert.ok(existsSync(res.workspaceFile));
      assert.ok(existsSync(res.settingsFile));
      assert.ok(existsSync(res.mcpConfigFile));

      const cw = JSON.parse(readFileSync(res.workspaceFile, 'utf8'));
      assert.equal(cw.workspaceUri, 'workspaces://awesome-os/os-dev');
      assert.ok(cw.folders.some((f: { name: string }) => f.name === 'ladybird'));

      const mcp = JSON.parse(readFileSync(res.mcpConfigFile, 'utf8'));
      assert.equal(mcp.servers['awesome-os'].command, 'holo-host-manager');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
