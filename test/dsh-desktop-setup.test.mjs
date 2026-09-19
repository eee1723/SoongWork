import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(new URL('..', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0));
const setupScript = join(repoRoot, 'scripts', 'setup-dsh-desktop.ps1');

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createFakeDesktop(root) {
  const installDir = join(root, 'DSH Desktop');
  const dataDir = join(root, 'data');
  const appDir = join(installDir, 'resources', 'app');
  const presetDir = join(appDir, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard');
  await writeJson(join(appDir, 'package.json'), { name: 'dsh-desktop', version: '9.9.9-test' });
  await writeJson(join(appDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'package.json'), {
    name: '@deepseek-ai/dsh-mcp-client', version: '9.9.9-test',
  });
  await mkdir(presetDir, { recursive: true });
  await writeFile(join(presetDir, 'agent.cordis.yml'), [
    "- id: persona",
    "  name: '@deepseek-ai/dsh-persona'",
    '',
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '',
    '- id: tool-skill',
    "  name: '@deepseek-ai/dsh-tool-skill'",
    '',
    '- id: tool-web',
    "  name: '@deepseek-ai/dsh-tool-web'",
    '  config:',
    '    fetch: true',
    '',
    '- id: present',
    "  name: '@deepseek-ai/dsh-tool-present'",
    '',
  ].join('\n'), 'utf8');
  await writeFile(join(presetDir, 'preset.yml'), 'name: Standard\norder: 1\n', 'utf8');
  await writeJson(join(dataDir, 'harness', 'profiles', 'web', 'package.json'), { name: 'web-profile' });
  await writeFile(join(dataDir, 'harness', 'profiles', 'web', 'cordis.patch.yml'), '[]\n', 'utf8');
  await writeJson(join(dataDir, 'harness', 'storages', 'workspace.json'), {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
    tables: { workspaces: {} },
  });
  return { installDir, dataDir };
}

function runSetup({ installDir, dataDir }, extraArgs = []) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript,
    '-ProjectRoot', repoRoot,
    '-DesktopInstallDir', installDir,
    '-DesktopDataDir', dataDir,
    '-SkipNpmInstall',
    '-NoLaunch',
    ...extraArgs,
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `setup failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

test('DSH Desktop installer is repeatable and uninstall is scoped', {
  skip: process.platform !== 'win32' ? 'PowerShell/DSH Desktop integration is Windows-only' : false,
  timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-learning-desktop-'));
  const fake = await createFakeDesktop(root);

  runSetup(fake);
  const presetDir = join(fake.dataDir, 'harness', '.agent-presets', 'pet-learning');
  const preset = await readFile(join(presetDir, 'agent.cordis.yml'), 'utf8');
  assert.match(preset, /- id: skill-filesystem[\s\S]*includeDefaultRoots: false/);
  assert.match(preset, new RegExp(repoRoot.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(preset, /- id: tool-web\r?\n\s+name: '@deepseek-ai\/dsh-tool-web'\r?\n\s+disabled: true/);
  assert.match(preset, /- id: mcp-pet-learning[\s\S]*serverName: pet_learning/);

  const patch = await readFile(join(fake.dataDir, 'harness', 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /pet-learning installer managed begin/);
  assert.match(patch, /session-telemetry-otel[\s\S]*disabled: true/);

  let workspaceStore = JSON.parse(await readFile(join(fake.dataDir, 'harness', 'storages', 'workspace.json'), 'utf8'));
  assert.equal(workspaceStore.global.workspaceIds.length, 1);
  assert.equal(Object.values(workspaceStore.tables.workspaces)[0].path.toLowerCase(), repoRoot.toLowerCase());

  runSetup(fake);
  workspaceStore = JSON.parse(await readFile(join(fake.dataDir, 'harness', 'storages', 'workspace.json'), 'utf8'));
  assert.equal(workspaceStore.global.workspaceIds.length, 1, 'reinstall must not duplicate the workspace');

  runSetup(fake, ['-Uninstall']);
  await assert.rejects(readFile(join(presetDir, 'agent.cordis.yml'), 'utf8'), { code: 'ENOENT' });
  const cleanedPatch = await readFile(join(fake.dataDir, 'harness', 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(cleanedPatch, /pet-learning installer managed begin/);
  workspaceStore = JSON.parse(await readFile(join(fake.dataDir, 'harness', 'storages', 'workspace.json'), 'utf8'));
  assert.equal(workspaceStore.global.workspaceIds.length, 1, 'uninstall keeps workspace history by default');
});
