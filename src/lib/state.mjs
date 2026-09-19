import { randomUUID } from 'node:crypto';
import { transaction } from './catalog.mjs';
import { parseVersion } from './parsers.mjs';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID()}`;

function audit(db, eventType, objectType, objectId, detail = {}, actor = 'local-cli') {
  db.prepare(`INSERT INTO audit_event
    (event_id, occurred_at, event_type, object_type, object_id, actor, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id('EVT'), now(), eventType, objectType, objectId, actor, JSON.stringify(detail));
}

function required(value, label) {
  const text = value?.trim();
  if (!text) throw new Error(`${label} 不能为空`);
  return text;
}

export function createConflict({ db, title, versionIds }) {
  const members = [...new Set(versionIds || [])];
  if (members.length < 2) throw new Error('冲突组至少需要两个 version_id');
  for (const versionId of members) {
    if (!db.prepare('SELECT 1 FROM source_version WHERE version_id = ?').get(versionId)) {
      throw new Error(`找不到 version_id: ${versionId}`);
    }
  }
  const conflictGroupId = id('CNF');
  transaction(db, () => {
    db.prepare("INSERT INTO conflict_group(conflict_group_id, title, status, created_at) VALUES (?, ?, 'open', ?)")
      .run(conflictGroupId, required(title, 'title'), now());
    const insert = db.prepare('INSERT INTO conflict_member(conflict_group_id, version_id) VALUES (?, ?)');
    for (const versionId of members) insert.run(conflictGroupId, versionId);
  });
  return { conflictGroupId, status: 'open', versionIds: members };
}

export function resolveConflict({ db, conflictGroupId, resolution }) {
  const resolved = required(resolution, 'resolution');
  transaction(db, () => {
    const result = db.prepare(`UPDATE conflict_group SET status = 'resolved', resolution = ?, resolved_at = ?
      WHERE conflict_group_id = ? AND status = 'open'`).run(resolved, now(), conflictGroupId);
    if (result.changes !== 1) throw new Error(`找不到开放冲突组: ${conflictGroupId}`);
    audit(db, 'conflict_resolved', 'conflict_group', conflictGroupId, { resolution: resolved });
  });
  return { conflictGroupId, status: 'resolved', resolution };
}

export function addConcept({ db, name, description = null, aliases = [] }) {
  const conceptId = id('CON');
  const canonicalName = required(name, 'name');
  transaction(db, () => {
    db.prepare(`INSERT INTO concept(concept_id, canonical_name, description, review_status, created_at)
      VALUES (?, ?, ?, 'draft', ?)`).run(conceptId, canonicalName, description, now());
    const insert = db.prepare('INSERT INTO term_alias(alias, concept_id, disambiguation) VALUES (?, ?, NULL)');
    for (const alias of [...new Set(aliases.map((value) => value.trim()).filter(Boolean))]) insert.run(alias, conceptId);
  });
  return { conceptId, canonicalName, aliases, reviewStatus: 'draft' };
}

export function relateConcepts({ db, fromConceptId, toConceptId, type = 'related_to', citationId = null }) {
  const allowed = ['supports', 'contradicts', 'supersedes', 'prerequisite_of', 'part_of', 'applies_to', 'related_to'];
  if (!allowed.includes(type)) throw new Error(`无效关系类型: ${type}`);
  const relationId = id('KRL');
  db.prepare(`INSERT INTO knowledge_relation
    (relation_id, from_concept_id, to_concept_id, relation_type, citation_id, review_status, created_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?)`)
    .run(relationId, fromConceptId, toConceptId, type, citationId, now());
  return { relationId, fromConceptId, toConceptId, type, citationId, reviewStatus: 'draft' };
}

export function addMemory({
  db, config, category = 'candidate', content, sourceMessageId = null, sourceVersionId = null,
  confirmed = false, expiresAt = null,
}) {
  const allowed = ['preference', 'work_context', 'learning_state', 'candidate'];
  if (!allowed.includes(category)) throw new Error(`无效记忆类别: ${category}`);
  const memoryId = id('MEM');
  const status = confirmed && category !== 'candidate' ? 'confirmed' : 'candidate';
  db.prepare(`INSERT INTO memory_item
    (memory_id, category, content, project_id, source_message_id, source_version_id, status, created_at, reviewed_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(memoryId, category, required(content, 'content'), config.projectId, sourceMessageId, sourceVersionId,
      status, now(), status === 'confirmed' ? now() : null, expiresAt);
  audit(db, 'memory_proposed', 'memory_item', memoryId, { category, status, sourceMessageId, sourceVersionId });
  return { memoryId, category, content, status, expiresAt };
}

export function reviewMemory({ db, memoryId, action, replacement = null }) {
  const current = db.prepare('SELECT * FROM memory_item WHERE memory_id = ?').get(memoryId);
  if (!current) throw new Error(`找不到 memory_id: ${memoryId}`);
  if (action === 'confirm') {
    transaction(db, () => {
      db.prepare("UPDATE memory_item SET status = 'confirmed', reviewed_at = ? WHERE memory_id = ?").run(now(), memoryId);
      audit(db, 'memory_confirmed', 'memory_item', memoryId);
    });
    return { memoryId, status: 'confirmed' };
  }
  if (action === 'revoke') {
    transaction(db, () => {
      db.prepare("UPDATE memory_item SET status = 'revoked', reviewed_at = ? WHERE memory_id = ?").run(now(), memoryId);
      audit(db, 'memory_revoked', 'memory_item', memoryId);
    });
    return { memoryId, status: 'revoked' };
  }
  if (action === 'replace') {
    const replacementText = required(replacement, 'replacement');
    const newMemoryId = id('MEM');
    transaction(db, () => {
      db.prepare("UPDATE memory_item SET status = 'revoked', reviewed_at = ? WHERE memory_id = ?").run(now(), memoryId);
      db.prepare(`INSERT INTO memory_item
        (memory_id, category, content, project_id, source_message_id, source_version_id, status,
         replaces_memory_id, created_at, reviewed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`)
        .run(newMemoryId, current.category, replacementText, current.project_id, current.source_message_id,
          current.source_version_id, memoryId, now(), now(), current.expires_at);
      audit(db, 'memory_replaced', 'memory_item', memoryId, { replacementMemoryId: newMemoryId });
    });
    return { memoryId: newMemoryId, status: 'confirmed', replacesMemoryId: memoryId };
  }
  throw new Error(`无效记忆操作: ${action}`);
}

export function listMemories({ db, config, includeRevoked = false }) {
  const sql = `SELECT memory_id AS memoryId, category, content, status, source_message_id AS sourceMessageId,
    source_version_id AS sourceVersionId, replaces_memory_id AS replacesMemoryId, created_at AS createdAt,
    reviewed_at AS reviewedAt, expires_at AS expiresAt FROM memory_item
    WHERE project_id = ? ${includeRevoked ? '' : "AND status != 'revoked'"} ORDER BY created_at DESC`;
  return db.prepare(sql).all(config.projectId);
}

export function addWorkLog({ db, date, task, progress = null, decision = null, blocker = null, todo = null, sourceMessageId = null, sourceVersionId = null }) {
  const workLogId = id('WRK');
  db.prepare(`INSERT INTO work_log
    (work_log_id, occurred_on, task, progress, decision, blocker, todo, source_message_id, source_version_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(workLogId, required(date, 'date'), required(task, 'task'), progress, decision, blocker, todo,
      sourceMessageId, sourceVersionId, now());
  audit(db, 'work_log_added', 'work_log', workLogId, { sourceMessageId, sourceVersionId });
  return { workLogId, date, task };
}

export function addLearningLog({ db, date, topic, understanding = null, question = null, selfTest = null, reviewOn = null, status = 'learning', sourceMessageId = null, sourceVersionId = null }) {
  const allowed = ['not_started', 'learning', 'understood', 'review_due'];
  if (!allowed.includes(status)) throw new Error(`无效学习状态: ${status}`);
  const learningLogId = id('LRN');
  db.prepare(`INSERT INTO learning_log
    (learning_log_id, occurred_on, topic, understanding, question, self_test, review_on, status,
     source_message_id, source_version_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(learningLogId, required(date, 'date'), required(topic, 'topic'), understanding, question, selfTest,
      reviewOn, status, sourceMessageId, sourceVersionId, now());
  audit(db, 'learning_log_added', 'learning_log', learningLogId, { sourceMessageId, sourceVersionId, status });
  return { learningLogId, date, topic, status, reviewOn };
}

export function enqueueParse({ db, projectId, versionId }) {
  if (!db.prepare('SELECT 1 FROM source_version WHERE version_id = ?').get(versionId)) throw new Error(`找不到 version_id: ${versionId}`);
  const key = `${projectId}:parse:${versionId}:parser-set-v1`;
  const existing = db.prepare('SELECT * FROM processing_job WHERE idempotency_key = ?').get(key);
  if (existing) return { jobId: existing.job_id, status: existing.status, duplicate: true };
  const jobId = id('JOB');
  const timestamp = now();
  db.prepare(`INSERT INTO processing_job
    (job_id, idempotency_key, job_type, version_id, status, attempts, created_at, updated_at)
    VALUES (?, ?, 'parse', ?, 'pending', 0, ?, ?)`)
    .run(jobId, key, versionId, timestamp, timestamp);
  return { jobId, status: 'pending', duplicate: false };
}

export async function runJobs({ root, db, maxAttempts = 3 }) {
  const jobs = db.prepare(`SELECT * FROM processing_job
    WHERE status IN ('pending','failed') AND attempts < ? ORDER BY created_at`).all(maxAttempts);
  const results = [];
  for (const job of jobs) {
    db.prepare("UPDATE processing_job SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE job_id = ?")
      .run(now(), job.job_id);
    try {
      const output = job.job_type === 'parse'
        ? await parseVersion({ root, db, versionId: job.version_id })
        : (() => { throw new Error(`未知 job_type: ${job.job_type}`); })();
      db.prepare("UPDATE processing_job SET status = 'succeeded', last_error = NULL, updated_at = ? WHERE job_id = ?")
        .run(now(), job.job_id);
      results.push({ jobId: job.job_id, status: 'succeeded', output });
    } catch (error) {
      db.prepare("UPDATE processing_job SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ?")
        .run(error.message, now(), job.job_id);
      results.push({ jobId: job.job_id, status: 'failed', error: error.message });
    }
  }
  return results;
}
