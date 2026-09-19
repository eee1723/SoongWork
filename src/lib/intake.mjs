import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { atomicWriteJson, assertInside } from './project.mjs';
import { transaction } from './catalog.mjs';

function id(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function safeName(name) {
  const cleaned = basename(name).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  return cleaned || 'original.bin';
}

async function sha256(file) {
  const data = await readFile(file);
  return createHash('sha256').update(data).digest('hex');
}

function normalizeOptions(config, options) {
  return {
    title: options.title?.trim() || '未命名资料',
    sourceType: options.sourceType || 'file',
    sourceDomain: options.sourceDomain || 'user_submission',
    confidentiality: options.confidentiality || config.dataPolicy.defaultConfidentiality,
    originalReference: options.originalReference || null,
    documentDate: options.documentDate || null,
    versionLabel: options.versionLabel || null,
    sourceId: options.sourceId || null,
    supersedesVersionId: options.supersedesVersionId || null,
  };
}

function recordDuplicate(db, existing, inputKind, inputReference) {
  const submissionId = id('SUB');
  const now = new Date().toISOString();
  transaction(db, () => {
    db.prepare(`INSERT INTO intake_submission
      (submission_id, source_id, version_id, submitted_at, input_kind, input_reference, duplicate_content)
      VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(submissionId, existing.source_id, existing.version_id, now, inputKind, inputReference);
    db.prepare(`INSERT INTO audit_event
      (event_id, occurred_at, event_type, object_type, object_id, actor, detail_json)
      VALUES (?, ?, 'duplicate_received', 'source_version', ?, 'local-cli', ?)`)
      .run(id('EVT'), now, existing.version_id, JSON.stringify({ submissionId, inputKind, inputReference }));
  });
  return {
    sourceId: existing.source_id,
    versionId: existing.version_id,
    submissionId,
    sha256: existing.sha256,
    originalRelativePath: existing.original_relative_path,
    duplicateContent: true,
    processingStatus: existing.processing_status,
    reviewStatus: existing.review_status,
  };
}

async function persistNew({ root, config, db, stagedFile, fileName, digest, size, options, inputKind, inputReference }) {
  const sourceId = options.sourceId || id('SRC');
  const existingSource = options.sourceId
    ? db.prepare('SELECT source_id, title FROM source WHERE source_id = ? AND project_id = ?').get(options.sourceId, config.projectId)
    : null;
  if (options.sourceId && !existingSource) throw new Error(`找不到当前项目 source_id: ${options.sourceId}`);
  let superseded = null;
  if (options.supersedesVersionId) {
    superseded = db.prepare('SELECT version_id, source_id FROM source_version WHERE version_id = ?').get(options.supersedesVersionId);
    if (!superseded || superseded.source_id !== sourceId) {
      throw new Error('supersedes-version-id 必须属于同一 source_id');
    }
  }
  const versionId = id('VER');
  const submissionId = id('SUB');
  const now = new Date().toISOString();
  const versionDir = assertInside(root, join(root, 'sources', sourceId, versionId), 'source version');
  const originalDir = join(versionDir, 'original');
  const finalFile = join(originalDir, safeName(fileName));
  await mkdir(originalDir, { recursive: true });
  await rename(stagedFile, finalFile);
  const originalRelativePath = relative(root, finalFile).replaceAll('\\', '/');
  const manifest = {
    schemaVersion: config.schemaVersion,
    projectId: config.projectId,
    sourceId,
    versionId,
    title: options.title,
    sourceType: options.sourceType,
    sourceDomain: options.sourceDomain,
    confidentiality: options.confidentiality,
    originalReference: options.originalReference,
    receivedAt: now,
    documentDate: options.documentDate,
    versionLabel: options.versionLabel,
    supersedesVersionId: options.supersedesVersionId,
    sha256: digest,
    bytes: size,
    originalRelativePath,
    processingStatus: 'received',
    reviewStatus: 'draft',
    validityStatus: 'active',
  };
  await atomicWriteJson(join(versionDir, 'manifest.json'), manifest);

  try {
    transaction(db, () => {
      if (!existingSource) {
        db.prepare(`INSERT INTO source
          (source_id, project_id, source_type, title, source_domain, confidentiality, original_reference, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(sourceId, config.projectId, options.sourceType, options.title, options.sourceDomain,
            options.confidentiality, options.originalReference, now);
      }
      db.prepare(`INSERT INTO source_version
        (version_id, source_id, sha256, original_relative_path, received_at, document_date, version_label,
         processing_status, review_status, validity_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'received', 'draft', 'active')`)
        .run(versionId, sourceId, digest, originalRelativePath, now, options.documentDate, options.versionLabel);
      db.prepare(`INSERT INTO intake_submission
        (submission_id, source_id, version_id, submitted_at, input_kind, input_reference, duplicate_content)
        VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(submissionId, sourceId, versionId, now, inputKind, inputReference);
      db.prepare(`INSERT INTO audit_event
        (event_id, occurred_at, event_type, object_type, object_id, actor, detail_json)
        VALUES (?, ?, 'source_received', 'source_version', ?, 'local-cli', ?)`)
        .run(id('EVT'), now, versionId, JSON.stringify({ sourceId, submissionId, sha256: digest }));
      if (superseded) {
        db.prepare(`INSERT INTO source_relation
          (relation_id, from_version_id, to_version_id, relation_type, review_status, reason, created_at)
          VALUES (?, ?, ?, 'supersedes', 'draft', ?, ?)`)
          .run(id('REL'), versionId, superseded.version_id, '由接收命令显式指定', now);
        db.prepare("UPDATE source_version SET validity_status = 'superseded' WHERE version_id = ?")
          .run(superseded.version_id);
      }
    });
  } catch (error) {
    await atomicWriteJson(join(versionDir, 'catalog-write-failed.json'), {
      occurredAt: new Date().toISOString(),
      error: error.message,
      recovery: '运行 maintain/reconcile 前不要删除此目录。',
    });
    throw error;
  }

  return {
    sourceId,
    versionId,
    submissionId,
    sha256: digest,
    originalRelativePath,
    duplicateContent: false,
    processingStatus: 'received',
    reviewStatus: 'draft',
  };
}

export async function intakeFile({ root, config, db, file, ...rawOptions }) {
  const input = await stat(file);
  if (!input.isFile()) throw new Error(`不是普通文件: ${file}`);
  const options = normalizeOptions(config, { ...rawOptions, title: rawOptions.title || basename(file), sourceType: rawOptions.sourceType || 'file' });
  const stagingDir = assertInside(root, join(root, 'runtime', 'staging'), 'staging');
  await mkdir(stagingDir, { recursive: true });
  const stagedFile = join(stagingDir, `${randomUUID()}.part`);
  await copyFile(file, stagedFile);
  const digest = await sha256(stagedFile);
  const copied = await stat(stagedFile);
  const existing = db.prepare(`SELECT source_id, version_id, sha256, original_relative_path,
    processing_status, review_status FROM source_version WHERE sha256 = ?`).get(digest);
  if (existing) {
    await import('node:fs/promises').then(({ unlink }) => unlink(stagedFile));
    return recordDuplicate(db, existing, 'file', String(file));
  }
  return persistNew({
    root, config, db, stagedFile, fileName: basename(file), digest, size: copied.size,
    options, inputKind: 'file', inputReference: String(file),
  });
}

export async function intakeMessage({ root, config, db, text, messageId, ...rawOptions }) {
  if (!messageId?.trim()) throw new Error('message-id 不能为空');
  if (!text?.trim()) throw new Error('消息正文不能为空');
  const options = normalizeOptions(config, {
    ...rawOptions,
    title: rawOptions.title || `消息 ${messageId}`,
    sourceType: 'message',
    originalReference: messageId,
  });
  const stagingDir = assertInside(root, join(root, 'runtime', 'staging'), 'staging');
  await mkdir(stagingDir, { recursive: true });
  const stagedFile = join(stagingDir, `${randomUUID()}.part`);
  await writeFile(stagedFile, `${text.replace(/\r\n/g, '\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  const digest = await sha256(stagedFile);
  const copied = await stat(stagedFile);
  const existing = db.prepare(`SELECT source_id, version_id, sha256, original_relative_path,
    processing_status, review_status FROM source_version WHERE sha256 = ?`).get(digest);
  if (existing) {
    await import('node:fs/promises').then(({ unlink }) => unlink(stagedFile));
    return recordDuplicate(db, existing, 'message', messageId);
  }
  return persistNew({
    root, config, db, stagedFile, fileName: `${safeName(messageId)}.txt`, digest, size: copied.size,
    options, inputKind: 'message', inputReference: messageId,
  });
}
