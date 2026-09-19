import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { assertInside } from './project.mjs';
import { transaction } from './catalog.mjs';

const METRIC_UNITS = {
  document_pages: 'pages', media_minutes: 'minutes', ocr_pages: 'pages', asr_minutes: 'minutes',
  llm_input_tokens: 'tokens', llm_output_tokens: 'tokens', embedding_items: 'items',
  rerank_calls: 'calls', original_bytes: 'bytes', backup_bytes: 'bytes',
};

export function recordUsage({
  db, config, metric, quantity, provider = 'local', costMinor = null, currency = null,
  sourceVersionId = null, note = null, occurredAt = null,
}) {
  if (!(metric in METRIC_UNITS)) throw new Error(`无效 usage metric: ${metric}`);
  const amount = Number(quantity);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('quantity 必须是非负数');
  const minor = costMinor === null || costMinor === undefined ? null : Number(costMinor);
  if (minor !== null && (!Number.isInteger(minor) || minor < 0)) throw new Error('cost-minor 必须是非负整数');
  if ((minor === null) !== (!currency)) throw new Error('cost-minor 与 currency 必须同时提供或同时省略');
  if (sourceVersionId && !db.prepare('SELECT 1 FROM source_version WHERE version_id = ?').get(sourceVersionId)) {
    throw new Error(`找不到 source-version-id: ${sourceVersionId}`);
  }
  const usageId = `USG-${randomUUID()}`;
  const timestamp = occurredAt || new Date().toISOString();
  db.prepare(`INSERT INTO usage_ledger
    (usage_id, project_id, occurred_at, metric, quantity, unit, provider, cost_minor, currency, source_version_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(usageId, config.projectId, timestamp, metric, amount, METRIC_UNITS[metric], provider, minor,
      currency?.toUpperCase() || null, sourceVersionId, note);
  return { usageId, occurredAt: timestamp, metric, quantity: amount, unit: METRIC_UNITS[metric], provider, costMinor: minor, currency: currency?.toUpperCase() || null };
}

export function usageSummary({ db, config }) {
  return db.prepare(`SELECT metric, unit, provider, SUM(quantity) AS quantity,
    SUM(COALESCE(cost_minor, 0)) AS costMinor, currency
    FROM usage_ledger WHERE project_id = ? GROUP BY metric, unit, provider, currency ORDER BY metric, provider`)
    .all(config.projectId);
}

async function existingDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function countBackupCopies(root, sourceId) {
  const backupRoot = join(root, 'exports', 'backups');
  if (!await existingDirectory(backupRoot)) return 0;
  let count = 0;
  for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && await existingDirectory(join(backupRoot, entry.name, 'sources', sourceId))) count += 1;
  }
  return count;
}

export async function deletionImpact({ root, db, config, sourceId }) {
  const source = db.prepare(`SELECT source_id AS sourceId, title, source_type AS sourceType,
    confidentiality FROM source WHERE source_id = ? AND project_id = ?`).get(sourceId, config.projectId);
  if (!source) throw new Error(`找不到当前项目 source_id: ${sourceId}`);
  const alreadyDeleted = db.prepare('SELECT deleted_at AS deletedAt FROM source_deletion WHERE source_id = ?').get(sourceId);
  const versions = db.prepare(`SELECT version_id AS versionId, original_relative_path AS originalRelativePath,
    validity_status AS validityStatus FROM source_version WHERE source_id = ?`).all(sourceId);
  const ids = versions.map((row) => row.versionId);
  const aggregate = (table, column) => ids.reduce((total, versionId) => total +
    Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(versionId).count), 0);
  return {
    source, alreadyDeleted: alreadyDeleted || null, versions,
    counts: {
      artifacts: aggregate('artifact', 'version_id'), blocks: aggregate('block', 'version_id'),
      citations: aggregate('citation', 'version_id'), memories: aggregate('memory_item', 'source_version_id'),
      workLogs: aggregate('work_log', 'source_version_id'), learningLogs: aggregate('learning_log', 'source_version_id'),
      transcripts: aggregate('transcript_attachment', 'media_version_id'), keyframes: aggregate('media_keyframe', 'media_version_id'),
      externalProcessingRuns: aggregate('external_processing_run', 'version_id'),
    },
    backupCopiesUnaffected: await countBackupCopies(root, sourceId),
    consequences: [
      '原件、派生文件、全文索引和引用记录将从当前项目删除',
      '来源与版本只保留墓碑元数据和审计记录，检索不再返回正文',
      '已有备份不会自动清除，须按独立留存策略处理',
    ],
  };
}

export async function deleteSource({ root, db, config, sourceId, confirmSourceId, actor = 'local-cli' }) {
  if (confirmSourceId !== sourceId) throw new Error('删除确认失败：confirm-source-id 必须与 source-id 完全一致');
  const impact = await deletionImpact({ root, db, config, sourceId });
  if (impact.alreadyDeleted) return { sourceId, deleted: false, duplicate: true, impact };
  const operationId = randomUUID();
  const staging = assertInside(root, join(root, 'runtime', 'delete-staging', operationId), 'delete staging');
  await mkdir(staging, { recursive: true });
  const moved = [];
  const candidates = [
    { from: assertInside(root, join(root, 'sources', sourceId), 'source directory'), to: join(staging, 'source') },
    ...impact.versions.map((version, index) => ({
      from: assertInside(root, join(root, 'derived', version.versionId), 'derived directory'),
      to: join(staging, `derived-${index}`),
    })),
  ];
  try {
    for (const candidate of candidates) {
      if (await existingDirectory(candidate.from)) {
        await rename(candidate.from, candidate.to);
        moved.push(candidate);
      }
    }
    const versionIds = impact.versions.map((row) => row.versionId);
    transaction(db, () => {
      for (const versionId of versionIds) {
        const citationIds = db.prepare('SELECT citation_id FROM citation WHERE version_id = ?').all(versionId).map((row) => row.citation_id);
        for (const citationId of citationIds) {
          db.prepare('UPDATE knowledge_relation SET citation_id = NULL WHERE citation_id = ?').run(citationId);
        }
        const blockIds = db.prepare('SELECT block_id FROM block WHERE version_id = ?').all(versionId).map((row) => row.block_id);
        for (const blockId of blockIds) db.prepare('DELETE FROM block_fts WHERE block_id = ?').run(blockId);
        db.prepare(`UPDATE lesson_evidence SET resolution_status = 'pending',
          source_hint = COALESCE(source_hint, '已删除证据版本 ' || ?), version_id = NULL, block_id = NULL
          WHERE version_id = ?`).run(versionId, versionId);
        db.prepare('DELETE FROM glossary_evidence WHERE version_id = ?').run(versionId);
        db.prepare('DELETE FROM citation WHERE version_id = ?').run(versionId);
        db.prepare('DELETE FROM backend_mapping WHERE version_id = ?').run(versionId);
        db.prepare('DELETE FROM transcript_attachment WHERE media_version_id = ?').run(versionId);
        db.prepare('DELETE FROM media_keyframe WHERE media_version_id = ?').run(versionId);
        db.prepare('DELETE FROM derived_file WHERE version_id = ?').run(versionId);
        db.prepare('UPDATE external_processing_run SET artifact_id = NULL WHERE version_id = ?').run(versionId);
        db.prepare('DELETE FROM block WHERE version_id = ?').run(versionId);
        db.prepare('DELETE FROM artifact WHERE version_id = ?').run(versionId);
        db.prepare('DELETE FROM source_snapshot WHERE version_id = ?').run(versionId);
        db.prepare('DELETE FROM conflict_member WHERE version_id = ?').run(versionId);
        db.prepare('DELETE FROM source_relation WHERE from_version_id = ? OR to_version_id = ?').run(versionId, versionId);
        db.prepare('UPDATE memory_item SET source_version_id = NULL WHERE source_version_id = ?').run(versionId);
        db.prepare('UPDATE work_log SET source_version_id = NULL WHERE source_version_id = ?').run(versionId);
        db.prepare('UPDATE learning_log SET source_version_id = NULL WHERE source_version_id = ?').run(versionId);
        db.prepare("UPDATE processing_job SET status = 'failed', last_error = 'source deleted', updated_at = ? WHERE version_id = ? AND status != 'succeeded'")
          .run(new Date().toISOString(), versionId);
        db.prepare("UPDATE source_version SET validity_status = 'expired', processing_status = 'failed' WHERE version_id = ?").run(versionId);
      }
      const deletedAt = new Date().toISOString();
      db.prepare('INSERT INTO source_deletion(source_id, deleted_at, actor, impact_json) VALUES (?, ?, ?, ?)')
        .run(sourceId, deletedAt, actor, JSON.stringify(impact));
      db.prepare(`INSERT INTO audit_event(event_id, occurred_at, event_type, object_type, object_id, actor, detail_json)
        VALUES (?, ?, 'source_deleted', 'source', ?, ?, ?)`)
        .run(`EVT-${randomUUID()}`, deletedAt, sourceId, actor, JSON.stringify({ operationId, impact }));
    });
  } catch (error) {
    for (const candidate of moved.reverse()) await rename(candidate.to, candidate.from).catch(() => {});
    throw error;
  }
  await rm(staging, { recursive: true, force: true });
  return { sourceId, deleted: true, duplicate: false, removedDirectories: moved.map((item) => relative(root, item.from).replaceAll('\\', '/')), impact };
}
