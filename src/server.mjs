import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/project.mjs';
import { openCatalog } from './lib/catalog.mjs';
import { searchEvidence, verifyCitations } from './lib/evidence.mjs';
import { listMemories, reviewMemory } from './lib/state.mjs';
import { deletionImpact, usageSummary } from './lib/operations.mjs';
import {
  glossaryEntries, learningIssues, learningOverview, lessonDetail, searchLearning, updateLessonProgress,
} from './lib/learning.mjs';

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function securityHeaders(response) {
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}

async function readBody(request, maxBytes = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求正文超过 64 KiB');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function summary(db) {
  const scalar = (sql) => db.prepare(sql).get().count;
  return {
    sources: scalar('SELECT COUNT(*) AS count FROM source WHERE source_id NOT IN (SELECT source_id FROM source_deletion)'),
    versions: scalar('SELECT COUNT(*) AS count FROM source_version'),
    indexed: scalar("SELECT COUNT(*) AS count FROM source_version WHERE processing_status = 'indexed'"),
    failed: scalar("SELECT COUNT(*) AS count FROM source_version WHERE processing_status = 'failed'"),
    draftClaims: scalar("SELECT COUNT(*) AS count FROM claim WHERE status = 'draft'"),
    openConflicts: scalar("SELECT COUNT(*) AS count FROM conflict_group WHERE status = 'open'"),
    candidateMemories: scalar("SELECT COUNT(*) AS count FROM memory_item WHERE status = 'candidate'"),
    reviewDue: scalar("SELECT COUNT(*) AS count FROM learning_log WHERE status = 'review_due'"),
    stages: scalar('SELECT COUNT(*) AS count FROM learning_stage'),
    lessons: scalar("SELECT COUNT(*) AS count FROM learning_lesson WHERE review_status != 'rejected'"),
    understoodLessons: scalar("SELECT COUNT(*) AS count FROM lesson_progress WHERE status = 'understood'"),
    pendingLearningIssues: scalar("SELECT COUNT(*) AS count FROM learning_issue WHERE status = 'pending'"),
    usageRecords: scalar('SELECT COUNT(*) AS count FROM usage_ledger'),
    deletedSources: scalar('SELECT COUNT(*) AS count FROM source_deletion'),
    updatedAt: new Date().toISOString(),
  };
}

export async function createDashboardServer({ root = moduleRoot } = {}) {
  const config = await loadConfig(root);
  const db = openCatalog(root, config);
  const csrfToken = randomBytes(24).toString('hex');
  const assets = {
    '/': { file: join(root, 'dashboard', 'index.html'), type: 'text/html; charset=utf-8' },
    '/app.js': { file: join(root, 'dashboard', 'app.js'), type: 'text/javascript; charset=utf-8' },
    '/styles.css': { file: join(root, 'dashboard', 'styles.css'), type: 'text/css; charset=utf-8' },
  };

  const server = createServer(async (request, response) => {
    securityHeaders(response);
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && assets[url.pathname]) {
        const asset = assets[url.pathname];
        const body = await readFile(asset.file);
        response.writeHead(200, { 'content-type': asset.type, 'content-length': body.length });
        response.end(body);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        sendJson(response, 200, { project: { id: config.projectId, name: config.name }, csrfToken, summary: summary(db) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/summary') {
        sendJson(response, 200, summary(db));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/search') {
        sendJson(response, 200, searchEvidence({ db, query: url.searchParams.get('q'), limit: url.searchParams.get('limit') }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/sources') {
        sendJson(response, 200, db.prepare(`SELECT s.source_id AS sourceId, s.title, s.source_type AS sourceType,
          v.version_id AS versionId, v.version_label AS versionLabel, v.processing_status AS processingStatus,
          v.review_status AS reviewStatus, v.validity_status AS validityStatus, v.received_at AS receivedAt
          FROM source s JOIN source_version v ON v.source_id = s.source_id
          LEFT JOIN source_deletion d ON d.source_id = s.source_id
          WHERE d.source_id IS NULL ORDER BY v.received_at DESC`).all());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/memories') {
        sendJson(response, 200, listMemories({ db, config, includeRevoked: url.searchParams.get('revoked') === 'true' }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/work') {
        sendJson(response, 200, db.prepare('SELECT * FROM work_log ORDER BY occurred_on DESC, created_at DESC LIMIT 100').all());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/learning') {
        sendJson(response, 200, db.prepare('SELECT * FROM learning_log ORDER BY occurred_on DESC, created_at DESC LIMIT 100').all());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/curriculum') {
        sendJson(response, 200, learningOverview(db));
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/lessons/')) {
        const lessonId = decodeURIComponent(url.pathname.slice('/api/lessons/'.length));
        if (!lessonId || lessonId.includes('/')) throw new Error('lessonId 无效');
        sendJson(response, 200, lessonDetail(db, lessonId));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/glossary') {
        sendJson(response, 200, glossaryEntries(db, url.searchParams.get('q') || ''));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/learning-issues') {
        sendJson(response, 200, learningIssues(db));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/learning-search') {
        sendJson(response, 200, searchLearning(db, url.searchParams.get('q')));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/governance') {
        const citations = await verifyCitations({ root, db });
        sendJson(response, 200, {
          conflicts: db.prepare("SELECT * FROM conflict_group WHERE status = 'open' ORDER BY created_at DESC").all(),
          failedJobs: db.prepare("SELECT * FROM processing_job WHERE status = 'failed' ORDER BY updated_at DESC").all(),
          invalidCitations: citations.filter((item) => !item.valid),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/usage') {
        sendJson(response, 200, usageSummary({ db, config }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/deletion-impact') {
        const sourceId = url.searchParams.get('sourceId');
        if (!sourceId) throw new Error('sourceId 必填');
        sendJson(response, 200, await deletionImpact({ root, db, config, sourceId }));
        return;
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/memories/')) {
        if (request.headers['x-csrf-token'] !== csrfToken) {
          sendJson(response, 403, { error: 'CSRF token 无效' });
          return;
        }
        const memoryId = decodeURIComponent(url.pathname.slice('/api/memories/'.length));
        const body = await readBody(request);
        sendJson(response, 200, reviewMemory({ db, memoryId, action: body.action, replacement: body.replacement }));
        return;
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/lessons/') && url.pathname.endsWith('/progress')) {
        if (request.headers['x-csrf-token'] !== csrfToken) {
          sendJson(response, 403, { error: 'CSRF token 无效' });
          return;
        }
        const lessonId = decodeURIComponent(url.pathname.slice('/api/lessons/'.length, -'/progress'.length));
        if (!lessonId || lessonId.includes('/')) throw new Error('lessonId 无效');
        const body = await readBody(request);
        sendJson(response, 200, updateLessonProgress({
          db, lessonId, status: body.status, note: body.note, answerIndex: body.answerIndex, reviewOn: body.reviewOn,
        }));
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
  });

  server.on('close', () => db.close());
  return { server, csrfToken, config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, config } = await createDashboardServer({ root: process.env.PET_LEARNING_ROOT || moduleRoot });
  const port = Number(process.env.PET_DASHBOARD_PORT || 3210);
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`宠物医疗工作与学习看板：${config.name}\nhttp://127.0.0.1:${port}\n`);
  });
}
