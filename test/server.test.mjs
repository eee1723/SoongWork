import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureProjectDirs } from '../src/lib/project.mjs';
import { openCatalog } from '../src/lib/catalog.mjs';
import { intakeMessage } from '../src/lib/intake.mjs';
import { indexPlainText } from '../src/lib/evidence.mjs';
import { createDashboardServer } from '../src/server.mjs';
import { importLearningBundle } from '../src/lib/learning.mjs';

const config = {
  schemaVersion: 5,
  projectId: 'dashboard-test',
  name: '测试看板',
  dataPolicy: { defaultConfidentiality: 'internal', externalTransmissionAllowed: false, realCompanyDataApproved: false },
  network: { mode: 'deny-by-default', approvedServices: [] },
  dsh: { home: 'runtime/dsh-home', knowledgeBaseId: null, memoryScope: null },
};

test('dashboard API binds locally, searches evidence and requires CSRF for writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pet-dashboard-'));
  await ensureProjectDirs(root);
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'config', 'project.json'), `${JSON.stringify(config)}\n`, 'utf8');
  const db = openCatalog(root, config);
  const intake = await intakeMessage({ root, config, db, messageId: 'dashboard-msg', text: '看板检索脱敏证据' });
  await indexPlainText({ root, db, versionId: intake.versionId });
  importLearningBundle({
    db, config, classification: 'synthetic', origin: 'server-test', reference: {},
    curriculum: {
      stages: [{ id: 'safe', title: '安全学习' }],
      lessons: [{ id: 'safe-lesson', stage: 'safe', title: '合成课节', body: '只用于测试', minutes: 3, sources: [], web: [],
        quiz: { question: '正确选项？', options: ['A', 'B'], answer: 1, explain: 'B 正确' } }],
      refs: {},
    },
  });
  db.close();

  const { server } = await createDashboardServer({ root });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const bootstrap = await fetch(`${base}/api/bootstrap`);
  assert.equal(bootstrap.status, 200);
  assert.match(bootstrap.headers.get('content-security-policy'), /default-src 'self'/);
  const boot = await bootstrap.json();
  assert.equal(boot.summary.sources, 1);
  assert.equal(boot.summary.lessons, 1);
  assert.ok(boot.csrfToken);

  const search = await fetch(`${base}/api/search?q=${encodeURIComponent('脱敏证据')}`).then((response) => response.json());
  assert.equal(search.length, 1);
  const forbidden = await fetch(`${base}/api/memories/none`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }),
  });
  assert.equal(forbidden.status, 403);
  const curriculum = await fetch(`${base}/api/curriculum`).then((response) => response.json());
  assert.equal(curriculum[0].lessons[0].lessonId, 'safe-lesson');
  const lesson = await fetch(`${base}/api/lessons/safe-lesson`).then((response) => response.json());
  assert.equal('answerIndex' in lesson.quiz, false);
  const progress = await fetch(`${base}/api/lessons/safe-lesson/progress`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrfToken },
    body: JSON.stringify({ answerIndex: 1, status: 'understood', note: '已主动回忆' }),
  });
  assert.equal(progress.status, 200);
  assert.equal((await progress.json()).lastAnswerCorrect, true);
});

test('dashboard assets contain no remote dependencies or inline executable script', async () => {
  const root = resolve(import.meta.dirname, '..');
  const html = await readFile(join(root, 'dashboard', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.match(html, /证据台/);
});
