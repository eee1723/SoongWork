import { createHash, randomUUID } from 'node:crypto';
import { transaction } from './catalog.mjs';

const now = () => new Date().toISOString();
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const stableId = (prefix, value) => `${prefix}-${hash(value).slice(0, 24)}`;

function text(value, label, { optional = false, max = 200_000 } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new Error(`${label} 不能为空`);
  }
  const result = String(value).trim();
  if (!result && !optional) throw new Error(`${label} 不能为空`);
  if (result.length > max) throw new Error(`${label} 超过 ${max} 字符`);
  return result || null;
}

function normalizeStageId(value) {
  const raw = text(value, 'stage id', { max: 80 });
  return /^[a-z0-9][a-z0-9_-]*$/i.test(raw) ? `stage-${raw}` : stableId('STG', raw);
}

function normalizeLessonId(value) {
  const raw = text(value, 'lesson id', { max: 120 });
  return /^[a-z0-9][a-z0-9_-]*$/i.test(raw) ? raw : stableId('LSN', raw);
}

function riskFromLegacy(value = '') {
  if (/临床|医学|诊断|治疗|用药/.test(value)) return 'medical';
  if (/操作|采样|流程/.test(value)) return 'operational';
  if (/版本|型号|说明书/.test(value)) return 'version';
  if (/数据|单位|界值|数字/.test(value)) return 'data';
  return 'other';
}

function validateClassification(config, classification) {
  const allowed = ['synthetic', 'deidentified', 'internal'];
  if (!allowed.includes(classification)) throw new Error(`无效内容分类: ${classification}`);
  if (classification === 'internal' && !config.dataPolicy?.realCompanyDataApproved) {
    throw new Error('项目尚未批准真实公司资料，拒绝导入 internal 学习内容');
  }
}

export function importLearningBundle({ db, config, curriculum, reference = {}, origin = 'local-file', classification = 'synthetic' }) {
  validateClassification(config, classification);
  if (!Array.isArray(curriculum?.stages) || !Array.isArray(curriculum?.lessons)) {
    throw new Error('课程文件必须包含 stages 和 lessons 数组');
  }
  const digest = hash(JSON.stringify({ curriculum, reference }));
  const previous = db.prepare('SELECT import_id AS importId, summary_json AS summaryJson FROM learning_import WHERE content_sha256 = ?').get(digest);
  if (previous) return { importId: previous.importId, duplicate: true, ...JSON.parse(previous.summaryJson) };

  const refs = curriculum.refs && typeof curriculum.refs === 'object' ? curriculum.refs : {};
  const timestamp = now();
  const stageIds = new Map();
  const lessonIds = new Map();
  const summary = {
    stages: curriculum.stages.length,
    lessons: curriculum.lessons.length,
    quizzes: 0,
    pendingEvidence: 0,
    externalReferences: 0,
    glossaryTerms: Array.isArray(reference.terms) ? reference.terms.length : 0,
    pendingIssues: Array.isArray(reference.issues) ? reference.issues.length : 0,
  };

  transaction(db, () => {
    curriculum.stages.forEach((stage, index) => {
      const sourceId = stage.id ?? index;
      const stageId = normalizeStageId(sourceId);
      stageIds.set(String(sourceId), stageId);
      db.prepare(`INSERT INTO learning_stage(stage_id, title, intro, goal, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stage_id) DO UPDATE SET title=excluded.title, intro=excluded.intro, goal=excluded.goal,
          sort_order=excluded.sort_order, updated_at=excluded.updated_at`)
        .run(stageId, text(stage.title, 'stage title', { max: 240 }), text(stage.intro, 'stage intro', { optional: true }),
          text(stage.goal, 'stage goal', { optional: true }), index, timestamp, timestamp);
    });

    const lessonOrder = new Map();
    for (const lesson of curriculum.lessons) {
      const lessonId = normalizeLessonId(lesson.id);
      const stageId = stageIds.get(String(lesson.stage));
      if (!stageId) throw new Error(`课节 ${lesson.id} 引用了不存在的阶段: ${lesson.stage}`);
      lessonIds.set(String(lesson.id), lessonId);
      const order = lessonOrder.get(stageId) || 0;
      lessonOrder.set(stageId, order + 1);
      const minutes = Number(lesson.minutes ?? 10);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) throw new Error(`课节 ${lesson.id} 的 minutes 无效`);
      db.prepare(`INSERT INTO learning_lesson
        (lesson_id, stage_id, title, brief, body, remember, estimated_minutes, review_status, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
        ON CONFLICT(lesson_id) DO UPDATE SET stage_id=excluded.stage_id, title=excluded.title, brief=excluded.brief,
          body=excluded.body, remember=excluded.remember, estimated_minutes=excluded.estimated_minutes,
          sort_order=excluded.sort_order, updated_at=excluded.updated_at`)
        .run(lessonId, stageId, text(lesson.title, 'lesson title', { max: 300 }),
          text(lesson.brief, 'lesson brief', { optional: true }), text(lesson.body, 'lesson body'),
          text(lesson.remember, 'lesson remember', { optional: true }), minutes, order, timestamp, timestamp);

      if (lesson.quiz) {
        const options = lesson.quiz.options;
        const answer = Number(lesson.quiz.answer);
        if (!Array.isArray(options) || options.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) {
          throw new Error(`课节 ${lesson.id} 的 quiz 无效`);
        }
        db.prepare(`INSERT INTO lesson_quiz(quiz_id, lesson_id, question, options_json, answer_index, explanation)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(lesson_id) DO UPDATE SET question=excluded.question, options_json=excluded.options_json,
            answer_index=excluded.answer_index, explanation=excluded.explanation`)
          .run(stableId('QIZ', lessonId), lessonId, text(lesson.quiz.question, 'quiz question'),
            JSON.stringify(options.map((option) => text(option, 'quiz option', { max: 500 }))), answer,
            text(lesson.quiz.explain, 'quiz explanation'));
        summary.quizzes += 1;
      }

      db.prepare("DELETE FROM lesson_evidence WHERE lesson_id = ? AND resolution_status = 'pending'").run(lessonId);
      for (const [sourceHint, locator] of lesson.sources || []) {
        db.prepare(`INSERT INTO lesson_evidence
          (evidence_id, lesson_id, source_hint, locator_hint_json, evidence_role, resolution_status, created_at)
          VALUES (?, ?, ?, ?, 'context', 'pending', ?)`)
          .run(stableId('LEV', `${lessonId}:${sourceHint}:${JSON.stringify(locator)}`), lessonId,
            text(sourceHint, 'source hint', { max: 200 }), JSON.stringify({ page: locator }), timestamp);
        summary.pendingEvidence += 1;
      }

      db.prepare('DELETE FROM lesson_external_reference WHERE lesson_id = ?').run(lessonId);
      for (const key of lesson.web || []) {
        const external = refs[key];
        if (!Array.isArray(external) || external.length < 2) continue;
        let url;
        try { url = new URL(external[1]); } catch { throw new Error(`课节 ${lesson.id} 的外部 URL 无效: ${external[1]}`); }
        if (url.protocol !== 'https:') throw new Error(`外部参考必须使用 HTTPS: ${url}`);
        db.prepare(`INSERT INTO lesson_external_reference(reference_id, lesson_id, title, url, checked_at, review_status)
          VALUES (?, ?, ?, ?, ?, 'draft')`)
          .run(stableId('LXR', `${lessonId}:${key}`), lessonId, text(external[0], 'reference title', { max: 500 }), url.href,
            reference.updated || null);
        summary.externalReferences += 1;
      }
    }

    for (const term of reference.terms || []) {
      const lessonId = term.lesson ? lessonIds.get(String(term.lesson)) || null : null;
      const termId = stableId('TRM', `${term.key}:${lessonId || ''}`);
      db.prepare(`INSERT INTO glossary_entry(term_id, term, plain_name, meaning, category, lesson_id, review_status)
        VALUES (?, ?, ?, ?, ?, ?, 'draft')
        ON CONFLICT(term_id) DO UPDATE SET term=excluded.term, plain_name=excluded.plain_name,
          meaning=excluded.meaning, category=excluded.category, lesson_id=excluded.lesson_id`)
        .run(termId, text(term.key, 'term', { max: 240 }), text(term.name, 'plain name', { optional: true, max: 500 }),
          text(term.meaning, 'meaning', { max: 4000 }), text(term.category, 'category', { optional: true, max: 200 }), lessonId);
    }

    for (const issue of reference.issues || []) {
      const issueId = stableId('ISS', `${issue.title}:${issue.where || ''}`);
      db.prepare(`INSERT INTO learning_issue
        (issue_id, title, source_locator, original_statement, learning_guidance, question_to_resolve,
         risk_level, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(issue_id) DO UPDATE SET source_locator=excluded.source_locator,
          original_statement=excluded.original_statement, learning_guidance=excluded.learning_guidance,
          question_to_resolve=excluded.question_to_resolve, risk_level=excluded.risk_level, updated_at=excluded.updated_at`)
        .run(issueId, text(issue.title, 'issue title', { max: 500 }), text(issue.where, 'issue source', { optional: true }),
          text(issue.original, 'issue original', { optional: true }), text(issue.learn, 'issue guidance', { optional: true }),
          text(issue.ask, 'issue question', { optional: true }), riskFromLegacy(issue.level), timestamp, timestamp);
    }

    const importId = `LIM-${randomUUID()}`;
    db.prepare(`INSERT INTO learning_import(import_id, origin, classification, content_sha256, imported_at, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(importId, text(origin, 'origin', { max: 1000 }), classification, digest, timestamp, JSON.stringify(summary));
    db.prepare(`INSERT INTO audit_event
      (event_id, occurred_at, event_type, object_type, object_id, actor, detail_json)
      VALUES (?, ?, 'learning_bundle_imported', 'learning_import', ?, 'local-cli', ?)`)
      .run(`EVT-${randomUUID()}`, timestamp, importId, JSON.stringify({ origin, classification, ...summary }));
    summary.importId = importId;
  });
  return { ...summary, duplicate: false };
}

export function learningOverview(db) {
  const stages = db.prepare(`SELECT stage_id AS stageId, title, intro, goal, sort_order AS sortOrder
    FROM learning_stage ORDER BY sort_order, stage_id`).all();
  const lessons = db.prepare(`SELECT l.lesson_id AS lessonId, l.stage_id AS stageId, l.title, l.brief,
    l.estimated_minutes AS estimatedMinutes, l.review_status AS reviewStatus, l.sort_order AS sortOrder,
    COALESCE(p.status, 'not_started') AS status, p.updated_at AS progressUpdatedAt
    FROM learning_lesson l LEFT JOIN lesson_progress p ON p.lesson_id = l.lesson_id
    WHERE l.review_status != 'rejected' ORDER BY l.stage_id, l.sort_order, l.lesson_id`).all();
  return stages.map((stage) => ({ ...stage, lessons: lessons.filter((lesson) => lesson.stageId === stage.stageId) }));
}

export function lessonDetail(db, lessonId) {
  const lesson = db.prepare(`SELECT l.lesson_id AS lessonId, l.stage_id AS stageId, l.title, l.brief, l.body,
    l.remember, l.estimated_minutes AS estimatedMinutes, l.review_status AS reviewStatus,
    COALESCE(p.status, 'not_started') AS status, p.note, p.last_answer_index AS lastAnswerIndex,
    p.last_answer_correct AS lastAnswerCorrect, p.review_on AS reviewOn
    FROM learning_lesson l LEFT JOIN lesson_progress p ON p.lesson_id = l.lesson_id WHERE l.lesson_id = ?`).get(lessonId);
  if (!lesson) throw new Error(`找不到 lesson_id: ${lessonId}`);
  const quiz = db.prepare('SELECT question, options_json AS optionsJson FROM lesson_quiz WHERE lesson_id = ?').get(lessonId);
  const evidence = db.prepare(`SELECT e.evidence_id AS evidenceId, e.evidence_role AS evidenceRole,
    e.resolution_status AS resolutionStatus, e.source_hint AS sourceHint, e.locator_hint_json AS locatorHintJson,
    e.version_id AS versionId, e.block_id AS blockId, s.title AS sourceTitle, b.locator_json AS locatorJson
    FROM lesson_evidence e
    LEFT JOIN source_version v ON v.version_id = e.version_id
    LEFT JOIN source s ON s.source_id = v.source_id
    LEFT JOIN block b ON b.block_id = e.block_id
    WHERE e.lesson_id = ? ORDER BY e.created_at`).all(lessonId).map((row) => ({
      ...row,
      locatorHint: row.locatorHintJson ? JSON.parse(row.locatorHintJson) : null,
      locator: row.locatorJson ? JSON.parse(row.locatorJson) : null,
      locatorHintJson: undefined,
      locatorJson: undefined,
    }));
  const externalReferences = db.prepare(`SELECT reference_id AS referenceId, title, url, checked_at AS checkedAt,
    review_status AS reviewStatus FROM lesson_external_reference WHERE lesson_id = ? ORDER BY title`).all(lessonId);
  return { ...lesson, quiz: quiz ? { question: quiz.question, options: JSON.parse(quiz.optionsJson) } : null, evidence, externalReferences };
}

export function updateLessonProgress({ db, lessonId, status, note, answerIndex, reviewOn }) {
  const lesson = db.prepare('SELECT lesson_id FROM learning_lesson WHERE lesson_id = ?').get(lessonId);
  if (!lesson) throw new Error(`找不到 lesson_id: ${lessonId}`);
  const allowed = ['not_started', 'learning', 'understood', 'review_due'];
  const current = db.prepare('SELECT * FROM lesson_progress WHERE lesson_id = ?').get(lessonId);
  const nextStatus = status ?? current?.status ?? 'learning';
  if (!allowed.includes(nextStatus)) throw new Error(`无效学习状态: ${nextStatus}`);
  const nextNote = note === undefined ? current?.note ?? null : text(note, 'note', { optional: true, max: 100_000 });
  let answer = current?.last_answer_index ?? null;
  let correct = current?.last_answer_correct ?? null;
  let explanation = null;
  if (answerIndex !== undefined && answerIndex !== null) {
    const quiz = db.prepare('SELECT options_json AS optionsJson, answer_index AS answerIndex, explanation FROM lesson_quiz WHERE lesson_id = ?').get(lessonId);
    if (!quiz) throw new Error('这节课没有练习题');
    answer = Number(answerIndex);
    const options = JSON.parse(quiz.optionsJson);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) throw new Error('answerIndex 无效');
    correct = answer === quiz.answerIndex ? 1 : 0;
    explanation = quiz.explanation;
  }
  const updatedAt = now();
  db.prepare(`INSERT INTO lesson_progress
    (lesson_id, status, note, last_answer_index, last_answer_correct, review_on, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lesson_id) DO UPDATE SET status=excluded.status, note=excluded.note,
      last_answer_index=excluded.last_answer_index, last_answer_correct=excluded.last_answer_correct,
      review_on=excluded.review_on, updated_at=excluded.updated_at`)
    .run(lessonId, nextStatus, nextNote, answer, correct, reviewOn ?? current?.review_on ?? null, updatedAt);
  return { lessonId, status: nextStatus, note: nextNote, lastAnswerIndex: answer,
    lastAnswerCorrect: correct === null ? null : Boolean(correct), explanation, reviewOn: reviewOn ?? current?.review_on ?? null, updatedAt };
}

export function glossaryEntries(db, query = '') {
  const value = query.trim();
  const rows = value
    ? db.prepare(`SELECT term_id AS termId, term, plain_name AS plainName, meaning, category, lesson_id AS lessonId,
        review_status AS reviewStatus FROM glossary_entry
        WHERE term LIKE ? OR plain_name LIKE ? OR meaning LIKE ? ORDER BY term LIMIT 100`)
      .all(`%${value}%`, `%${value}%`, `%${value}%`)
    : db.prepare(`SELECT term_id AS termId, term, plain_name AS plainName, meaning, category, lesson_id AS lessonId,
        review_status AS reviewStatus FROM glossary_entry ORDER BY category, term LIMIT 300`).all();
  return rows;
}

export function learningIssues(db) {
  return db.prepare(`SELECT issue_id AS issueId, title, source_locator AS sourceLocator,
    original_statement AS originalStatement, learning_guidance AS learningGuidance,
    question_to_resolve AS questionToResolve, risk_level AS riskLevel, status, conflict_group_id AS conflictGroupId
    FROM learning_issue WHERE status != 'dismissed' ORDER BY status, risk_level, title`).all();
}

export function searchLearning(db, query) {
  const value = text(query, 'query', { max: 500 });
  const pattern = `%${value}%`;
  return [
    ...db.prepare(`SELECT 'lesson' AS kind, lesson_id AS id, title, brief AS excerpt
      FROM learning_lesson WHERE review_status != 'rejected' AND (title LIKE ? OR brief LIKE ? OR body LIKE ?) LIMIT 50`)
      .all(pattern, pattern, pattern),
    ...db.prepare(`SELECT 'term' AS kind, term_id AS id, term AS title, meaning AS excerpt
      FROM glossary_entry WHERE review_status != 'rejected' AND (term LIKE ? OR plain_name LIKE ? OR meaning LIKE ?) LIMIT 50`)
      .all(pattern, pattern, pattern),
    ...db.prepare(`SELECT 'issue' AS kind, issue_id AS id, title, learning_guidance AS excerpt
      FROM learning_issue WHERE status != 'dismissed' AND (title LIKE ? OR original_statement LIKE ? OR learning_guidance LIKE ?) LIMIT 50`)
      .all(pattern, pattern, pattern),
  ];
}
