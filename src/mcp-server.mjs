#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { projectRoot, ensureProjectDirs, loadConfig } from './lib/project.mjs';
import { openCatalog } from './lib/catalog.mjs';
import { searchEvidence } from './lib/evidence.mjs';
import { integrityReport } from './lib/maintenance.mjs';
import { addLearningLog, addMemory, addWorkLog } from './lib/state.mjs';

const root = projectRoot(process.env.PET_LEARNING_ROOT || process.cwd());
await ensureProjectDirs(root);
const config = await loadConfig(root);
const db = openCatalog(root, config);

const server = new McpServer({ name: 'pet-learning-local', version: '0.1.0' });

function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

server.registerTool('search_evidence', {
  description: '在当前项目的有效本地原件索引中检索证据，返回 source_id、version_id、block_id 和真实定位。',
  inputSchema: {
    query: z.string().min(1).describe('检索词'),
    limit: z.number().int().min(1).max(50).optional().describe('最多结果数，默认 10'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, limit }) => result(searchEvidence({ db, query, limit })));

server.registerTool('list_sources', {
  description: '列出当前项目内的来源及版本状态。',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => result(db.prepare(`SELECT s.source_id AS sourceId, s.title, s.source_type AS sourceType,
  s.source_domain AS sourceDomain, s.confidentiality, v.version_id AS versionId,
  v.received_at AS receivedAt, v.document_date AS documentDate, v.version_label AS versionLabel,
  v.processing_status AS processingStatus, v.review_status AS reviewStatus,
  v.validity_status AS validityStatus, v.original_relative_path AS originalRelativePath
  FROM source s JOIN source_version v ON v.source_id = s.source_id
  WHERE s.project_id = ? ORDER BY v.received_at DESC`).all(config.projectId)));

server.registerTool('get_evidence_block', {
  description: '按 block_id 读取一个证据块及其来源、版本和定位。',
  inputSchema: { blockId: z.string().min(1).describe('证据块标识') },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ blockId }) => {
  const row = db.prepare(`SELECT b.block_id AS blockId, b.version_id AS versionId, b.text,
    b.locator_json AS locatorJson, s.source_id AS sourceId, s.title, s.source_type AS sourceType,
    v.original_relative_path AS originalRelativePath, v.validity_status AS validityStatus
    FROM block b JOIN source_version v ON v.version_id = b.version_id
    JOIN source s ON s.source_id = v.source_id WHERE b.block_id = ? AND s.project_id = ?`)
    .get(blockId, config.projectId);
  if (!row) throw new Error(`找不到当前项目内的 block_id: ${blockId}`);
  return result({ ...row, locator: JSON.parse(row.locatorJson), locatorJson: undefined });
});

server.registerTool('check_integrity', {
  description: '检查 SQLite、原件哈希、派生物哈希、全文索引和引用完整性。',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => result(await integrityReport({ root, db })));

server.registerTool('add_memory_candidate', {
  description: '保存一条待人工确认的项目内记忆候选；此工具不会直接创建已确认记忆。',
  inputSchema: {
    content: z.string().min(1).describe('候选记忆内容'),
    category: z.enum(['preference', 'work_context', 'learning_state', 'candidate']).optional(),
    sourceMessageId: z.string().optional(),
    sourceVersionId: z.string().optional(),
    expiresAt: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => result(addMemory({
  db, config, category: input.category || 'candidate', content: input.content,
  sourceMessageId: input.sourceMessageId, sourceVersionId: input.sourceVersionId,
  confirmed: false, expiresAt: input.expiresAt,
})));

server.registerTool('add_work_log', {
  description: '向当前项目追加工作日志，不覆盖既有记录。',
  inputSchema: {
    date: z.string().min(1), task: z.string().min(1), progress: z.string().optional(),
    decision: z.string().optional(), blocker: z.string().optional(), todo: z.string().optional(),
    sourceMessageId: z.string().optional(), sourceVersionId: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => result(addWorkLog({ db, ...input })));

server.registerTool('add_learning_log', {
  description: '向当前项目追加学习日志，不覆盖既有记录。',
  inputSchema: {
    date: z.string().min(1), topic: z.string().min(1), understanding: z.string().optional(),
    question: z.string().optional(), selfTest: z.string().optional(), reviewOn: z.string().optional(),
    status: z.enum(['not_started', 'learning', 'understood', 'review_due']).optional(),
    sourceMessageId: z.string().optional(), sourceVersionId: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => result(addLearningLog({ db, ...input })));

const shutdown = async () => {
  db.close();
  await server.close();
};
process.once('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });

await server.connect(new StdioServerTransport());
