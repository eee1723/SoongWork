import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const SCHEMA_VERSION = 6;

export function projectRoot(from = process.cwd()) {
  return resolve(from);
}

export function assertInside(root, candidate, label = 'path') {
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return target;
  throw new Error(`${label} 超出项目范围: ${target}`);
}

export async function loadConfig(root) {
  const file = assertInside(root, join(root, 'config', 'project.json'), 'config');
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`不支持的 schemaVersion: ${value.schemaVersion}`);
  }
  if (!value.projectId || typeof value.projectId !== 'string') {
    throw new Error('config/project.json 缺少 projectId');
  }
  return value;
}

export const DATA_DIRS = [
  'inbox',
  'sources',
  'derived',
  'knowledge',
  'journal/work',
  'journal/learning',
  'governance',
  'runtime',
  'dashboard',
  'eval/fixtures',
  'exports',
];

export async function ensureProjectDirs(root) {
  for (const rel of DATA_DIRS) {
    await mkdir(assertInside(root, join(root, rel), rel), { recursive: true });
  }
}

export async function atomicWriteJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, file);
}
