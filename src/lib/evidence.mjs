import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { atomicWriteJson, assertInside } from './project.mjs';
import { transaction } from './catalog.mjs';

const PARSER_NAME = 'plain-text-lines';
const PARSER_VERSION = '1';

function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function hashFile(file) {
  const data = await readFile(file);
  return createHash('sha256').update(data).digest('hex');
}

function deterministicId(prefix, value) {
  return `${prefix}-${hashText(value).slice(0, 32)}`;
}

export function splitText(text, maxChars = 1200) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let buffer = [];
  let startLine = 1;
  let headingPath = [];

  function flush(endLine) {
    const value = buffer.join('\n').trim();
    if (value) {
      blocks.push({
        text: value,
        locator: {
          kind: 'line',
          startLine,
          endLine,
          ...(headingPath.length ? { headingPath: [...headingPath] } : {}),
        },
      });
    }
    buffer = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      flush(lineNumber - 1);
      const level = heading[1].length;
      headingPath = [...headingPath.slice(0, level - 1), heading[2]];
      startLine = lineNumber;
      buffer.push(line);
      continue;
    }
    const projectedLength = buffer.join('\n').length + line.length + 1;
    if ((line.trim() === '' && buffer.length) || (projectedLength > maxChars && buffer.length)) {
      flush(lineNumber - 1);
      startLine = line.trim() ? lineNumber : lineNumber + 1;
      if (!line.trim()) continue;
    }
    if (!buffer.length) startLine = lineNumber;
    buffer.push(line);
  }
  flush(lines.length);
  return blocks;
}

export function originalForVersion(root, db, versionId) {
  const row = db.prepare(`SELECT v.version_id, v.sha256, v.original_relative_path, v.processing_status,
    s.source_id, s.title, s.source_type
    FROM source_version v JOIN source s ON s.source_id = v.source_id WHERE v.version_id = ?`).get(versionId);
  if (!row) throw new Error(`找不到 version_id: ${versionId}`);
  return { ...row, file: assertInside(root, join(root, row.original_relative_path), 'original') };
}

export async function persistParsedBlocks({
  root,
  db,
  source,
  parserName,
  parserVersion = '1',
  artifactKind = 'structured_text',
  parsedBlocks,
  metadata = {},
}) {
  const versionId = source.version_id;
  const artifactId = deterministicId('ART', `${versionId}:${parserName}:${parserVersion}`);
  const existing = db.prepare('SELECT artifact_id FROM artifact WHERE artifact_id = ?').get(artifactId);
  if (existing) {
    const count = db.prepare('SELECT COUNT(*) AS count FROM block WHERE artifact_id = ?').get(artifactId).count;
    return { artifactId, versionId, blockCount: count, duplicate: true, processingStatus: 'indexed' };
  }
  if (!parsedBlocks.length) throw new Error('解析结果没有可索引内容');
  const blocks = parsedBlocks.map((entry, ordinal) => ({
    blockId: deterministicId('BLK', `${artifactId}:${ordinal}:${entry.text}`),
    ordinal,
    text: entry.text,
    textSha256: hashText(entry.text),
    locator: entry.locator,
  }));
  const derivedRelativePath = `derived/${versionId}/${parserName}-v${parserVersion}.json`;
  const derivedFile = assertInside(root, join(root, derivedRelativePath), 'derived artifact');
  const artifactPayload = {
    schemaVersion: 2,
    artifactId,
    versionId,
    parser: { name: parserName, version: parserVersion },
    sourceSha256: source.sha256,
    metadata,
    blocks,
  };
  await atomicWriteJson(derivedFile, artifactPayload);
  const artifactHash = await hashFile(derivedFile);
  const now = new Date().toISOString();

  transaction(db, () => {
    db.prepare(`INSERT INTO artifact
      (artifact_id, version_id, artifact_kind, parser_name, parser_version, derived_relative_path, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(artifactId, versionId, artifactKind, parserName, parserVersion, derivedRelativePath, artifactHash, now);
    const insertBlock = db.prepare(`INSERT INTO block
      (block_id, artifact_id, version_id, ordinal, locator_kind, locator_json, text, text_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = db.prepare('INSERT INTO block_fts(block_id, text) VALUES (?, ?)');
    for (const block of blocks) {
      insertBlock.run(block.blockId, artifactId, versionId, block.ordinal, block.locator.kind,
        JSON.stringify(block.locator), block.text, block.textSha256, now);
      insertFts.run(block.blockId, block.text);
    }
    db.prepare("UPDATE source_version SET processing_status = 'indexed' WHERE version_id = ?").run(versionId);
    db.prepare(`INSERT INTO audit_event
      (event_id, occurred_at, event_type, object_type, object_id, actor, detail_json)
      VALUES (?, ?, 'artifact_indexed', 'artifact', ?, 'local-cli', ?)`)
      .run(`EVT-${randomUUID()}`, now, artifactId, JSON.stringify({ versionId, blockCount: blocks.length, parserName, parserVersion }));
  });
  return { artifactId, versionId, blockCount: blocks.length, duplicate: false, processingStatus: 'indexed' };
}

export async function indexPlainText({ root, db, versionId }) {
  const source = originalForVersion(root, db, versionId);
  const extension = basename(source.file).toLowerCase().split('.').pop();
  if (!['txt', 'md', 'markdown'].includes(extension)) {
    throw new Error(`plain-text-lines 不支持 .${extension}；当前只允许 txt/md/markdown`);
  }
  const actualHash = await hashFile(source.file);
  if (actualHash !== source.sha256) throw new Error(`原件哈希不一致，拒绝解析: ${versionId}`);
  const text = await readFile(source.file, 'utf8');
  if (text.includes('\u0000')) throw new Error('文本包含 NUL，疑似二进制文件');

  const parsed = splitText(text);
  return persistParsedBlocks({
    root, db, source, parserName: PARSER_NAME, parserVersion: PARSER_VERSION, parsedBlocks: parsed,
  });
}

function quoteFts(query) {
  return `"${query.replaceAll('"', '""')}"`;
}

export function searchEvidence({ db, query, limit = 10 }) {
  const value = query?.trim();
  if (!value) throw new Error('检索词不能为空');
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  let rows = [];
  if ([...value].length >= 3) {
    rows = db.prepare(`SELECT b.block_id AS blockId, b.version_id AS versionId, b.text,
      b.locator_json AS locatorJson, s.source_id AS sourceId, s.title, s.source_type AS sourceType,
      v.original_relative_path AS originalRelativePath,
      bm25(block_fts) AS score
      FROM block_fts
      JOIN block b ON b.block_id = block_fts.block_id
      JOIN source_version v ON v.version_id = b.version_id
      JOIN source s ON s.source_id = v.source_id
      WHERE block_fts MATCH ? AND v.validity_status = 'active'
      ORDER BY score LIMIT ?`).all(quoteFts(value), safeLimit);
  }
  if (!rows.length) {
    rows = db.prepare(`SELECT b.block_id AS blockId, b.version_id AS versionId, b.text,
      b.locator_json AS locatorJson, s.source_id AS sourceId, s.title, s.source_type AS sourceType,
      v.original_relative_path AS originalRelativePath, 0 AS score
      FROM block b
      JOIN source_version v ON v.version_id = b.version_id
      JOIN source s ON s.source_id = v.source_id
      WHERE instr(b.text, ?) > 0 AND v.validity_status = 'active'
      ORDER BY v.received_at DESC, b.ordinal LIMIT ?`).all(value, safeLimit);
  }
  return rows.map((row) => ({ ...row, locator: JSON.parse(row.locatorJson), locatorJson: undefined }));
}

export function createClaim({ db, statement, risk = 'low' }) {
  const text = statement?.trim();
  if (!text) throw new Error('结论不能为空');
  if (!['low', 'medium', 'high'].includes(risk)) throw new Error(`无效风险级别: ${risk}`);
  const claimId = `CLM-${randomUUID()}`;
  db.prepare(`INSERT INTO claim(claim_id, statement, status, risk, created_at)
    VALUES (?, ?, 'draft', ?, ?)`).run(claimId, text, risk, new Date().toISOString());
  return { claimId, statement: text, status: 'draft', risk };
}

export function citeClaim({ db, claimId, blockId, role = 'supports' }) {
  if (!['supports', 'refutes'].includes(role)) throw new Error(`无效证据角色: ${role}`);
  const claim = db.prepare('SELECT claim_id FROM claim WHERE claim_id = ?').get(claimId);
  if (!claim) throw new Error(`找不到 claim_id: ${claimId}`);
  const block = db.prepare('SELECT block_id, version_id, locator_json, text FROM block WHERE block_id = ?').get(blockId);
  if (!block) throw new Error(`找不到 block_id: ${blockId}`);
  const citationId = `CIT-${randomUUID()}`;
  db.prepare(`INSERT INTO citation
    (citation_id, claim_id, version_id, block_id, locator_json, excerpt_hash, evidence_role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(citationId, claimId, block.version_id, blockId, block.locator_json, hashText(block.text), role, new Date().toISOString());
  return { citationId, claimId, versionId: block.version_id, blockId, locator: JSON.parse(block.locator_json), role };
}

export async function verifyCitations({ root, db, citationId = null }) {
  const rows = citationId
    ? db.prepare(`SELECT c.*, b.text, b.locator_json AS current_locator, v.sha256 AS source_sha256,
        v.original_relative_path FROM citation c
        JOIN block b ON b.block_id = c.block_id
        JOIN source_version v ON v.version_id = c.version_id WHERE c.citation_id = ?`).all(citationId)
    : db.prepare(`SELECT c.*, b.text, b.locator_json AS current_locator, v.sha256 AS source_sha256,
        v.original_relative_path FROM citation c
        JOIN block b ON b.block_id = c.block_id
        JOIN source_version v ON v.version_id = c.version_id ORDER BY c.created_at`).all();
  if (citationId && !rows.length) throw new Error(`找不到 citation_id: ${citationId}`);
  const results = [];
  for (const row of rows) {
    let sourceHashMatches = false;
    try {
      const original = assertInside(root, join(root, row.original_relative_path), 'original');
      sourceHashMatches = (await stat(original)).isFile() && await hashFile(original) === row.source_sha256;
    } catch {
      sourceHashMatches = false;
    }
    const excerptMatches = hashText(row.text) === row.excerpt_hash;
    const locatorMatches = row.locator_json === row.current_locator;
    results.push({
      citationId: row.citation_id,
      claimId: row.claim_id,
      versionId: row.version_id,
      blockId: row.block_id,
      valid: sourceHashMatches && excerptMatches && locatorMatches,
      checks: { sourceHashMatches, excerptMatches, locatorMatches },
    });
  }
  return results;
}
