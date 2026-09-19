import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { assertInside } from './project.mjs';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_meta (
  project_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source (
  source_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  confidentiality TEXT NOT NULL,
  original_reference TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_version (
  version_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(source_id),
  sha256 TEXT NOT NULL,
  original_relative_path TEXT NOT NULL,
  received_at TEXT NOT NULL,
  document_date TEXT,
  version_label TEXT,
  processing_status TEXT NOT NULL CHECK (processing_status IN ('received','parsing','indexed','failed')),
  review_status TEXT NOT NULL CHECK (review_status IN ('draft','reviewed','rejected')),
  validity_status TEXT NOT NULL CHECK (validity_status IN ('active','superseded','expired')),
  UNIQUE (sha256)
);

CREATE TABLE IF NOT EXISTS intake_submission (
  submission_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(source_id),
  version_id TEXT NOT NULL REFERENCES source_version(version_id),
  submitted_at TEXT NOT NULL,
  input_kind TEXT NOT NULL,
  input_reference TEXT,
  duplicate_content INTEGER NOT NULL CHECK (duplicate_content IN (0,1))
);

CREATE TABLE IF NOT EXISTS audit_event (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_project ON source(project_id);
CREATE INDEX IF NOT EXISTS idx_version_source ON source_version(source_id);
CREATE INDEX IF NOT EXISTS idx_submission_version ON intake_submission(version_id);
CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_event(object_type, object_id);
`;

const MIGRATION_V2_SQL = `
CREATE TABLE IF NOT EXISTS artifact (
  artifact_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES source_version(version_id),
  artifact_kind TEXT NOT NULL,
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  derived_relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(version_id, artifact_kind, parser_name, parser_version)
);

CREATE TABLE IF NOT EXISTS block (
  block_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact(artifact_id),
  version_id TEXT NOT NULL REFERENCES source_version(version_id),
  ordinal INTEGER NOT NULL,
  locator_kind TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id, ordinal)
);

CREATE VIRTUAL TABLE IF NOT EXISTS block_fts USING fts5(
  block_id UNINDEXED,
  text,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS claim (
  claim_id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','reviewed','rejected')),
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citation (
  citation_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claim(claim_id),
  version_id TEXT NOT NULL REFERENCES source_version(version_id),
  block_id TEXT NOT NULL REFERENCES block(block_id),
  locator_json TEXT NOT NULL,
  excerpt_hash TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK (evidence_role IN ('supports','refutes')),
  created_at TEXT NOT NULL,
  UNIQUE(claim_id, block_id, evidence_role)
);

CREATE INDEX IF NOT EXISTS idx_artifact_version ON artifact(version_id);
CREATE INDEX IF NOT EXISTS idx_block_version ON block(version_id);
CREATE INDEX IF NOT EXISTS idx_citation_claim ON citation(claim_id);
CREATE INDEX IF NOT EXISTS idx_citation_block ON citation(block_id);
`;

const MIGRATION_V3_SQL = `
CREATE TABLE IF NOT EXISTS source_relation (
  relation_id TEXT PRIMARY KEY,
  from_version_id TEXT NOT NULL REFERENCES source_version(version_id),
  to_version_id TEXT NOT NULL REFERENCES source_version(version_id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes','contradicts','related_to')),
  review_status TEXT NOT NULL CHECK (review_status IN ('draft','reviewed','rejected')),
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(from_version_id, to_version_id, relation_type)
);

CREATE TABLE IF NOT EXISTS conflict_group (
  conflict_group_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS conflict_member (
  conflict_group_id TEXT NOT NULL REFERENCES conflict_group(conflict_group_id),
  version_id TEXT NOT NULL REFERENCES source_version(version_id),
  PRIMARY KEY(conflict_group_id, version_id)
);

CREATE TABLE IF NOT EXISTS processing_job (
  job_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL,
  version_id TEXT REFERENCES source_version(version_id),
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backend_mapping (
  backend TEXT NOT NULL,
  base_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES source_version(version_id),
  block_id TEXT NOT NULL REFERENCES block(block_id),
  index_generation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(backend, base_id, document_id, chunk_id, index_generation)
);

CREATE TABLE IF NOT EXISTS concept (
  concept_id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  description TEXT,
  review_status TEXT NOT NULL CHECK (review_status IN ('draft','reviewed','rejected')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS term_alias (
  alias TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concept(concept_id),
  disambiguation TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_relation (
  relation_id TEXT PRIMARY KEY,
  from_concept_id TEXT NOT NULL REFERENCES concept(concept_id),
  to_concept_id TEXT NOT NULL REFERENCES concept(concept_id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supports','contradicts','supersedes','prerequisite_of','part_of','applies_to','related_to')),
  citation_id TEXT REFERENCES citation(citation_id),
  review_status TEXT NOT NULL CHECK (review_status IN ('draft','reviewed','rejected')),
  created_at TEXT NOT NULL,
  UNIQUE(from_concept_id, to_concept_id, relation_type)
);

CREATE TABLE IF NOT EXISTS memory_item (
  memory_id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('preference','work_context','learning_state','candidate')),
  content TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_message_id TEXT,
  source_version_id TEXT REFERENCES source_version(version_id),
  status TEXT NOT NULL CHECK (status IN ('candidate','confirmed','revoked')),
  replaces_memory_id TEXT REFERENCES memory_item(memory_id),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS work_log (
  work_log_id TEXT PRIMARY KEY,
  occurred_on TEXT NOT NULL,
  task TEXT NOT NULL,
  progress TEXT,
  decision TEXT,
  blocker TEXT,
  todo TEXT,
  source_message_id TEXT,
  source_version_id TEXT REFERENCES source_version(version_id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_log (
  learning_log_id TEXT PRIMARY KEY,
  occurred_on TEXT NOT NULL,
  topic TEXT NOT NULL,
  understanding TEXT,
  question TEXT,
  self_test TEXT,
  review_on TEXT,
  status TEXT NOT NULL CHECK (status IN ('not_started','learning','understood','review_due')),
  source_message_id TEXT,
  source_version_id TEXT REFERENCES source_version(version_id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_relation_from ON source_relation(from_version_id);
CREATE INDEX IF NOT EXISTS idx_job_status ON processing_job(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_item(project_id, status, category);
CREATE INDEX IF NOT EXISTS idx_learning_review ON learning_log(status, review_on);
`;

const MIGRATION_V4_SQL = `
CREATE TABLE IF NOT EXISTS source_snapshot (
  version_id TEXT PRIMARY KEY REFERENCES source_version(version_id),
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  content_type TEXT,
  permitted_scope TEXT NOT NULL,
  http_status INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_attachment (
  attachment_id TEXT PRIMARY KEY,
  media_version_id TEXT NOT NULL REFERENCES source_version(version_id),
  artifact_id TEXT NOT NULL REFERENCES artifact(artifact_id),
  transcript_kind TEXT NOT NULL CHECK (transcript_kind IN ('raw','corrected')),
  transcript_relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  language TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(media_version_id, transcript_kind, sha256)
);

CREATE TABLE IF NOT EXISTS media_keyframe (
  keyframe_id TEXT PRIMARY KEY,
  media_version_id TEXT NOT NULL REFERENCES source_version(version_id),
  time_ms INTEGER NOT NULL CHECK (time_ms >= 0),
  image_relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(media_version_id, time_ms, sha256)
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  usage_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN (
    'document_pages','media_minutes','ocr_pages','asr_minutes','llm_input_tokens',
    'llm_output_tokens','embedding_items','rerank_calls','original_bytes','backup_bytes'
  )),
  quantity REAL NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  provider TEXT NOT NULL,
  cost_minor INTEGER CHECK (cost_minor IS NULL OR cost_minor >= 0),
  currency TEXT,
  source_version_id TEXT REFERENCES source_version(version_id),
  note TEXT
);

CREATE TABLE IF NOT EXISTS source_deletion (
  source_id TEXT PRIMARY KEY REFERENCES source(source_id),
  deleted_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  impact_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transcript_media ON transcript_attachment(media_version_id, transcript_kind);
CREATE INDEX IF NOT EXISTS idx_keyframe_media ON media_keyframe(media_version_id, time_ms);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_ledger(project_id, occurred_at, metric);
`;

export function openCatalog(root, config) {
  const file = assertInside(root, join(root, 'runtime', 'catalog.sqlite'), 'catalog');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(SCHEMA_SQL);
  const existingProject = db.prepare('SELECT project_id, schema_version FROM project_meta LIMIT 1').get();
  if (existingProject && existingProject.project_id !== config.projectId) {
    db.close();
    throw new Error(`目录账本属于项目 ${existingProject.project_id}，拒绝以 ${config.projectId} 打开`);
  }
  if (config.schemaVersion > 4) {
    db.close();
    throw new Error(`代码不支持 schemaVersion ${config.schemaVersion}`);
  }
  if (existingProject && existingProject.schema_version > config.schemaVersion) {
    db.close();
    throw new Error(`目录账本 schema ${existingProject.schema_version} 高于配置 ${config.schemaVersion}，拒绝降级`);
  }
  if (!existingProject) {
    db.prepare(`INSERT INTO project_meta(project_id, schema_version, created_at) VALUES (?, 1, ?)`)
      .run(config.projectId, new Date().toISOString());
  }
  let currentVersion = existingProject?.schema_version ?? 1;
  if (currentVersion < 2 && config.schemaVersion >= 2) {
    transaction(db, () => {
      db.exec(MIGRATION_V2_SQL);
      db.prepare('UPDATE project_meta SET schema_version = 2 WHERE project_id = ?').run(config.projectId);
    });
    currentVersion = 2;
  } else if (config.schemaVersion >= 2) {
    db.exec(MIGRATION_V2_SQL);
  }
  if (currentVersion < 3 && config.schemaVersion >= 3) {
    transaction(db, () => {
      db.exec(MIGRATION_V3_SQL);
      db.prepare('UPDATE project_meta SET schema_version = 3 WHERE project_id = ?').run(config.projectId);
    });
  } else if (config.schemaVersion >= 3) {
    db.exec(MIGRATION_V3_SQL);
  }
  if (currentVersion < 4 && config.schemaVersion >= 4) {
    transaction(db, () => {
      db.exec(MIGRATION_V4_SQL);
      db.prepare('UPDATE project_meta SET schema_version = 4 WHERE project_id = ?').run(config.projectId);
    });
  } else if (config.schemaVersion >= 4) {
    db.exec(MIGRATION_V4_SQL);
  }
  return db;
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
