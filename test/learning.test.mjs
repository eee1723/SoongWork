import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureProjectDirs } from '../src/lib/project.mjs';
import { openCatalog } from '../src/lib/catalog.mjs';
import {
  glossaryEntries, importLearningBundle, learningOverview, lessonDetail, searchLearning, updateLessonProgress,
} from '../src/lib/learning.mjs';

const config = {
  schemaVersion: 6,
  projectId: 'learning-test',
  dataPolicy: { defaultConfidentiality: 'internal', realCompanyDataApproved: false },
};

const curriculum = {
  stages: [{ id: 'one', title: '第一阶段', intro: '入门' }],
  lessons: [{
    id: 'lesson-one', stage: 'one', title: '证据入门', brief: '学会定位', body: '# 正文\n合成学习内容',
    remember: '回到原件', minutes: 5, sources: [['培训资料.pptx', '第 2 页']], web: [],
    quiz: { question: '哪项可复核？', options: ['传闻', '带定位的证据'], answer: 1, explain: '定位可以复核。' },
  }],
  refs: {},
};
const reference = {
  terms: [{ key: '证据块', name: '可定位片段', meaning: '带真实定位的最小片段', category: '基础', lesson: 'lesson-one' }],
  issues: [{ title: '旧资料版本不明', where: '第 2 页', ask: '核对授权版本', level: '版本' }],
};

test('learning bundle import is safe, idempotent and keeps source hints pending', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pet-learning-course-'));
  await ensureProjectDirs(root);
  const db = openCatalog(root, config);
  t.after(() => db.close());

  assert.throws(() => importLearningBundle({ db, config, curriculum, reference, classification: 'internal' }), /尚未批准真实公司资料/);
  const first = importLearningBundle({ db, config, curriculum, reference, classification: 'deidentified', origin: 'unit-test' });
  assert.equal(first.lessons, 1);
  assert.equal(first.pendingEvidence, 1);
  assert.equal(importLearningBundle({ db, config, curriculum, reference, classification: 'deidentified', origin: 'unit-test' }).duplicate, true);

  const overview = learningOverview(db);
  assert.equal(overview[0].lessons[0].status, 'not_started');
  const lesson = lessonDetail(db, 'lesson-one');
  assert.equal(lesson.evidence[0].resolutionStatus, 'pending');
  assert.equal(lesson.evidence[0].versionId, null);
  assert.deepEqual(lesson.quiz.options, ['传闻', '带定位的证据']);
  assert.equal('answerIndex' in lesson.quiz, false);

  const wrong = updateLessonProgress({ db, lessonId: 'lesson-one', answerIndex: 0, note: '先复习' });
  assert.equal(wrong.lastAnswerCorrect, false);
  const right = updateLessonProgress({ db, lessonId: 'lesson-one', answerIndex: 1, status: 'understood' });
  assert.equal(right.lastAnswerCorrect, true);
  assert.equal(learningOverview(db)[0].lessons[0].status, 'understood');
  assert.equal(glossaryEntries(db, '可定位')[0].term, '证据块');
  assert.equal(searchLearning(db, '合成学习').some((row) => row.kind === 'lesson'), true);
});
