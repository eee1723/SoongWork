import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureProjectDirs, loadConfig } from '../src/lib/project.mjs';
import { openCatalog } from '../src/lib/catalog.mjs';
import { intakeFile } from '../src/lib/intake.mjs';
import { parseVersion } from '../src/lib/parsers.mjs';

const repoRoot = resolve(new URL('..', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0));

test('MCP server exposes governed local tools and can search evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-learning-mcp-'));
  await cp(join(repoRoot, 'config'), join(root, 'config'), { recursive: true });
  await ensureProjectDirs(root);
  const config = await loadConfig(root);
  const fixture = join(root, 'fixture.txt');
  await writeFile(fixture, '犬猫疫苗记录必须包含接种日期和产品批号。', 'utf8');
  const db = openCatalog(root, config);
  const intake = await intakeFile({ root, config, db, file: fixture, title: '合成疫苗记录', sourceType: 'document' });
  await parseVersion({ root, db, versionId: intake.versionId });
  db.close();

  const client = new Client({ name: 'pet-learning-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'src', 'mcp-server.mjs')],
    env: { ...process.env, PET_LEARNING_ROOT: root },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'add_learning_log', 'add_memory_candidate', 'add_work_log', 'check_integrity',
      'get_evidence_block', 'list_sources', 'search_evidence',
    ]);
    const response = await client.callTool({ name: 'search_evidence', arguments: { query: '疫苗' } });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.result.length, 1);
    assert.equal(response.structuredContent.result[0].versionId, intake.versionId);
    const memory = await client.callTool({
      name: 'add_memory_candidate', arguments: { category: 'preference', content: '偏好表格总结' },
    });
    assert.equal(memory.structuredContent.result.status, 'candidate');
  } finally {
    await client.close();
  }
});
