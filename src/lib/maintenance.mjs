import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { assertInside } from './project.mjs';
import { verifyCitations } from './evidence.mjs';

async function fileHash(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function walk(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) output.push(...await walk(root, full));
    else if (entry.isFile()) output.push({ file: full, relativePath: relative(root, full).replaceAll('\\', '/') });
  }
  return output;
}

export async function integrityReport({ root, db }) {
  const issues = [];
  const sqlite = db.prepare('PRAGMA integrity_check').all();
  if (sqlite.length !== 1 || sqlite[0].integrity_check !== 'ok') issues.push({ severity: 'critical', kind: 'sqlite', detail: sqlite });

  const versions = db.prepare(`SELECT v.version_id, v.sha256, v.original_relative_path
    FROM source_version v JOIN source s ON s.source_id = v.source_id
    LEFT JOIN source_deletion d ON d.source_id = s.source_id WHERE d.source_id IS NULL`).all();
  for (const version of versions) {
    try {
      const file = assertInside(root, join(root, version.original_relative_path), 'original');
      if (!((await stat(file)).isFile()) || await fileHash(file) !== version.sha256) {
        issues.push({ severity: 'critical', kind: 'original_hash', id: version.version_id });
      }
    } catch (error) {
      issues.push({ severity: 'critical', kind: 'original_missing', id: version.version_id, detail: error.message });
    }
  }

  const artifacts = db.prepare('SELECT artifact_id, sha256, derived_relative_path FROM artifact').all();
  for (const artifact of artifacts) {
    try {
      const file = assertInside(root, join(root, artifact.derived_relative_path), 'derived');
      if (!((await stat(file)).isFile()) || await fileHash(file) !== artifact.sha256) {
        issues.push({ severity: 'high', kind: 'artifact_hash', id: artifact.artifact_id });
      }
    } catch (error) {
      issues.push({ severity: 'high', kind: 'artifact_missing', id: artifact.artifact_id, detail: error.message });
    }
  }

  const blockCount = db.prepare('SELECT COUNT(*) AS count FROM block').get().count;
  const ftsCount = db.prepare('SELECT COUNT(*) AS count FROM block_fts').get().count;
  if (blockCount !== ftsCount) issues.push({ severity: 'high', kind: 'fts_count', detail: { blockCount, ftsCount } });
  const citations = await verifyCitations({ root, db });
  for (const item of citations.filter((citation) => !citation.valid)) {
    issues.push({ severity: 'high', kind: 'citation_invalid', id: item.citationId, detail: item.checks });
  }
  const failedJobs = db.prepare("SELECT job_id, last_error FROM processing_job WHERE status = 'failed'").all();
  for (const job of failedJobs) issues.push({ severity: 'medium', kind: 'job_failed', id: job.job_id, detail: job.last_error });

  return {
    checkedAt: new Date().toISOString(),
    ok: !issues.some((issue) => ['critical', 'high'].includes(issue.severity)),
    counts: { versions: versions.length, artifacts: artifacts.length, blocks: blockCount, citations: citations.length },
    issues,
  };
}

const EXPORT_TABLES = [
  'project_meta', 'source', 'source_version', 'intake_submission', 'artifact', 'block', 'claim', 'citation',
  'source_relation', 'conflict_group', 'conflict_member', 'processing_job', 'backend_mapping', 'concept',
  'term_alias', 'knowledge_relation', 'memory_item', 'work_log', 'learning_log', 'source_snapshot',
  'transcript_attachment', 'media_keyframe', 'usage_ledger', 'source_deletion', 'audit_event',
];

export async function exportCatalog({ root, db, output = null }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = assertInside(root, output ? resolve(root, output) : join(root, 'exports', `catalog-${timestamp}.jsonl`), 'export');
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const schemaVersion = db.prepare('SELECT schema_version AS schemaVersion FROM project_meta LIMIT 1').get().schemaVersion;
  const lines = [JSON.stringify({ type: 'export_header', schemaVersion, exportedAt: new Date().toISOString() })];
  for (const table of EXPORT_TABLES) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) lines.push(JSON.stringify({ type: table, data: row }));
  }
  await writeFile(temporary, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, file);
  return { file, records: lines.length - 1, sha256: await fileHash(file) };
}

const SNAPSHOT_DIRS = ['config', 'sources', 'derived', 'knowledge', 'journal', 'governance'];

export async function createBackup({ root, db }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parent = assertInside(root, join(root, 'exports', 'backups'), 'backup parent');
  const finalDir = join(parent, timestamp);
  const temporary = join(parent, `.tmp-${timestamp}-${randomUUID()}`);
  await mkdir(temporary, { recursive: true });
  try {
    await sqliteBackup(db, join(temporary, 'catalog.sqlite'));
    for (const rel of SNAPSHOT_DIRS) {
      const source = join(root, rel);
      try {
        if ((await stat(source)).isDirectory()) await cp(source, join(temporary, rel), { recursive: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const files = await walk(temporary);
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      projectRootName: basename(root),
      files: await Promise.all(files.map(async (entry) => ({
        path: entry.relativePath,
        bytes: (await stat(entry.file)).size,
        sha256: await fileHash(entry.file),
      }))),
    };
    await writeFile(join(temporary, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await mkdir(parent, { recursive: true });
    await rename(temporary, finalDir);
    return { directory: finalDir, files: manifest.files.length + 1 };
  } catch (error) {
    await writeFile(join(temporary, 'BACKUP_FAILED.txt'), `${error.message}\n`, 'utf8').catch(() => {});
    throw error;
  }
}

export async function restoreBackup({ backupDir, targetDir }) {
  const source = resolve(backupDir);
  const target = resolve(targetDir);
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) throw new Error('backupDir 不是目录');
  try {
    const targetStat = await stat(target);
    if (!targetStat.isDirectory()) throw new Error('targetDir 已存在且不是目录');
    if ((await readdir(target)).length) throw new Error('targetDir 必须为空目录');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const manifest = JSON.parse(await readFile(join(source, 'backup-manifest.json'), 'utf8'));
  for (const item of manifest.files) {
    const file = resolve(source, item.path);
    if (!file.startsWith(`${source}\\`) && !file.startsWith(`${source}/`)) throw new Error(`备份清单路径越界: ${item.path}`);
    if (await fileHash(file) !== item.sha256) throw new Error(`备份哈希失败: ${item.path}`);
  }
  await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  const restoredDb = new DatabaseSync(join(target, 'catalog.sqlite'), { readOnly: true });
  const integrity = restoredDb.prepare('PRAGMA integrity_check').get().integrity_check;
  restoredDb.close();
  if (integrity !== 'ok') throw new Error(`恢复后的 SQLite 完整性失败: ${integrity}`);
  return { target, files: manifest.files.length, verified: true };
}
