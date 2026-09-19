import { access, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { atomicWriteJson, DATA_DIRS } from './project.mjs';

function item(id, status, detail) {
  return { id, status, detail };
}

function commandExists(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function configRow(output, id) {
  const marker = `- id: ${id}`;
  const start = output.indexOf(marker);
  if (start < 0) return '';
  const next = output.indexOf('\n- id: ', start + marker.length);
  return output.slice(start, next < 0 ? output.length : next);
}

async function inspectLocalDsh(root) {
  try {
    const packageFile = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const patch = join(root, 'config', 'dsh', 'local-safe.patch.yml');
    const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
    const output = execFileSync(process.execPath, [
      bin, '--profile', 'headless', '--patch', patch, '--dump-config',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_HOME: join(root, 'runtime', 'dsh-home'),
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: 'read-only',
        DEEPSEEK_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const disabledIds = ['session-telemetry-otel', 'session-log-deepseek', 'web-search-deepseek', 'web-fetch-http', 'tool-web'];
    const disabled = disabledIds.every((id) => configRow(output, id).includes('disabled: true'));
    const skillRow = configRow(output, 'skill-filesystem');
    const isolatedSkills = skillRow.includes('includeDefaultRoots: false') && skillRow.includes("/.dsh/skills'");
    const mcpRow = configRow(output, 'mcp-pet-learning');
    const localMcp = mcpRow.includes("@deepseek-ai/dsh-mcp-client") &&
      mcpRow.includes('serverName: pet_learning') && mcpRow.includes('/src/mcp-server.mjs');
    return {
      installed: true,
      version: pkg.version,
      safeConfig: disabled && isolatedSkills && localMcp,
      localMcp,
      detail: disabled && isolatedSkills && localMcp
        ? 'telemetry/web disabled; skill root isolated; local MCP configured over stdio'
        : 'expanded config does not satisfy isolation policy',
    };
  } catch (error) {
    return { installed: false, version: null, safeConfig: false, detail: error.message };
  }
}

function gitProjectRoot(root) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().replaceAll('\\', '/');
  } catch {
    return null;
  }
}

async function validateSkills(root) {
  const skillRoot = join(root, '.dsh', 'skills');
  const entries = await readdir(skillRoot, { withFileTypes: true });
  const problems = [];
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(skillRoot, entry.name, 'SKILL.md');
    try {
      const text = await readFile(file, 'utf8');
      const name = text.match(/^name:\s*(.+)$/m)?.[1]?.trim();
      const description = text.match(/^description:\s*(.+)$/m)?.[1]?.trim();
      if (name !== entry.name || !description) problems.push(entry.name);
      count += 1;
    } catch {
      problems.push(entry.name);
    }
  }
  return { count, problems };
}

export async function runP0({ root, config }) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(item('node-runtime', nodeMajor >= 24 ? 'pass' : 'blocked', process.version));
  checks.push(item('git-cli', commandExists('git') ? 'pass' : 'blocked', commandExists('git') ? 'available' : 'missing'));
  const repositoryRoot = gitProjectRoot(root);
  checks.push(item('git-project', repositoryRoot ? 'pass' : 'blocked', repositoryRoot || 'not a Git working tree'));
  const dsh = await inspectLocalDsh(root);
  checks.push(item('dsh-local', dsh.installed ? 'pass' : 'blocked', dsh.installed ? `@deepseek-ai/dsh ${dsh.version}` : dsh.detail));
  checks.push(item('dsh-safe-config', dsh.safeConfig ? 'pass' : 'blocked', dsh.detail));
  checks.push(item('dsh-local-mcp', dsh.localMcp ? 'pass' : 'blocked',
    dsh.localMcp ? 'pet_learning stdio MCP is present in expanded config; standalone protocol test is in test/mcp.test.mjs' : 'local MCP missing'));

  for (const rel of DATA_DIRS) {
    try {
      await access(join(root, rel), constants.R_OK | constants.W_OK);
      checks.push(item(`directory:${rel}`, 'pass', 'readable and writable'));
    } catch {
      checks.push(item(`directory:${rel}`, 'blocked', 'missing or not writable'));
    }
  }

  const skills = await validateSkills(root);
  checks.push(item('skill-files', skills.count >= 3 && skills.problems.length === 0 ? 'pass' : 'blocked',
    `${skills.count} discovered on disk; invalid: ${skills.problems.join(', ') || 'none'}`));
  checks.push(item('skill-runtime-discovery', 'needs-verification', 'root is isolated in expanded config; catalog still needs an observable Host-session test'));
  checks.push(item('agents-sentinel', 'needs-verification', 'observable model-session assertion requires an approved external model credential'));
  checks.push(item('project-isolation', config.dsh.knowledgeBaseId && config.dsh.memoryScope ? 'pass' : 'blocked',
    config.dsh.knowledgeBaseId && config.dsh.memoryScope
      ? `${config.dsh.knowledgeBaseId}; ${config.dsh.memoryScope}; catalog rejects mismatched project_id`
      : 'knowledgeBaseId and memoryScope must be configured'));
  checks.push(item('external-transmission', config.dataPolicy.externalTransmissionAllowed ? 'needs-verification' : 'pass',
    config.dataPolicy.externalTransmissionAllowed ? 'enabled by config' : 'denied by project config'));
  checks.push(item('real-company-data', config.dataPolicy.realCompanyDataApproved ? 'needs-verification' : 'blocked',
    config.dataPolicy.realCompanyDataApproved ? 'marked approved; verify authorization' : 'not approved'));
  try {
    const evaluation = JSON.parse(await readFile(join(root, 'eval', 'results', 'latest.json'), 'utf8'));
    const passed = evaluation.documents >= 20 && evaluation.queries >= 50 && evaluation.recallAt10 >= 0.9 && evaluation.passed;
    checks.push(item('sample-corpus', passed ? 'pass' : 'blocked',
      `${evaluation.documents} synthetic documents; ${evaluation.queries} queries; Recall@10=${evaluation.recallAt10}`));
  } catch (error) {
    checks.push(item('sample-corpus', 'blocked', `evaluation unavailable: ${error.message}`));
  }
  try {
    const locks = JSON.parse(await readFile(join(root, 'config', 'components.lock.json'), 'utf8'));
    const backend = locks.components.knowledgeBackend;
    checks.push(item('knowledge-backend', backend.status === 'approved' ? 'pass' : 'blocked',
      `${backend.package ?? 'none'} ${backend.version ?? ''}: ${backend.status}`));
    checks.push(item('dependency-audit', backend.audit?.high === 0 && backend.audit?.critical === 0 ? 'pass' : 'blocked',
      `high=${backend.audit?.high ?? 'unknown'}, critical=${backend.audit?.critical ?? 'unknown'}`));
    const candidate = locks.components.dshKnowledgeCandidate;
    checks.push(item('quarantined-candidate', candidate?.status === 'quarantined-security-review' ? 'pass' : 'blocked',
      candidate ? `${candidate.package} is not registered; high advisories=${candidate.audit?.high ?? 'unknown'}` : 'candidate record missing'));
  } catch (error) {
    checks.push(item('knowledge-backend', 'blocked', `component lock unavailable: ${error.message}`));
  }

  const intentionalGates = new Set(['real-company-data']);
  const localBlockers = checks.filter((check) => check.status === 'blocked' && !intentionalGates.has(check.id));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectId: config.projectId,
    root,
    overall: localBlockers.length ? 'blocked' : 'ready-for-synthetic-local-use',
    boundary: '脱敏/虚构资料的本地闭环可用；真实公司资料、外部模型传输与已隔离的 dsh-knowledge 候选仍不得启用。',
    checks,
  };
  await atomicWriteJson(join(root, 'governance', 'p0-compatibility-report.json'), report);
  const lines = [
    '# P0 兼容性报告', '',
    `生成时间：${report.generatedAt}`, '',
    `总体状态：**${report.overall}**`, '',
    report.boundary, '',
    '| 检查 | 状态 | 说明 |', '| --- | --- | --- |',
    ...checks.map((check) => `| ${check.id} | ${check.status} | ${String(check.detail).replaceAll('|', '\\|')} |`),
    '',
  ];
  await import('node:fs/promises').then(({ writeFile }) => writeFile(
    join(root, 'governance', 'p0-compatibility-report.md'), lines.join('\n'), 'utf8'));
  return report;
}
