let csrfToken = '';
const content = document.querySelector('#content');
const viewTitle = document.querySelector('#view-title');
const viewKicker = document.querySelector('#view-kicker');

const labels = {
  study: ['LEARNING TRAIL', '学习路径'], glossary: ['PLAIN LANGUAGE', '白话词典'],
  sources: ['SOURCE REGISTER', '资料版本'], memories: ['MEMORY REVIEW', '候选记忆'],
  learning: ['REVIEW LOG', '学习复习'], usage: ['USAGE LEDGER', '用量台账'],
  governance: ['GOVERNANCE WATCH', '治理异常'], search: ['UNIFIED RESULTS', '联合检索结果'],
  lesson: ['EVIDENCE-LED LESSON', '课节详情'],
};
const statusNames = { not_started: '未开始', learning: '学习中', understood: '已理解', review_due: '待复习' };

function setHeading(view, title) {
  [viewKicker.textContent, viewTitle.textContent] = labels[view];
  if (title) viewTitle.textContent = title;
}
function clearContent() { content.replaceChildren(); }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function empty(message) { clearContent(); content.append(element('p', 'empty', message)); }
function card({ meta, title, excerpt, locator, bad = false }) {
  const node = document.querySelector('#evidence-card').content.firstElementChild.cloneNode(true);
  node.querySelector('.card-meta').textContent = meta;
  node.querySelector('h3').textContent = title;
  node.querySelector('.excerpt').textContent = excerpt || '暂无补充内容';
  const location = node.querySelector('.locator');
  location.textContent = locator;
  if (bad) location.classList.add('state-bad');
  return node;
}
async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
async function post(path, body) {
  return api(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
}

function renderSummary(summary) {
  const fields = [
    ['学习阶段', summary.stages], ['课程', summary.lessons], ['已理解', summary.understoodLessons],
    ['来源', summary.sources], ['已索引', summary.indexed], ['待审结论', summary.draftClaims],
    ['开放冲突', summary.openConflicts], ['待复习', summary.reviewDue], ['学习问题', summary.pendingLearningIssues],
    ['外部失败', summary.failedExternalProcessing],
  ];
  const ledger = document.querySelector('#summary');
  ledger.replaceChildren(...fields.map(([label, value]) => {
    const row = element('div');
    row.append(element('dt', '', label), element('dd', '', value));
    return row;
  }));
  document.querySelector('#updated').textContent = `更新 ${new Date(summary.updatedAt).toLocaleString('zh-CN')}`;
}

function bodyFragment(markdown) {
  const fragment = document.createDocumentFragment();
  let list = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    if (line.startsWith('# ')) { fragment.append(element('h3', 'lesson-heading', line.slice(2))); list = null; }
    else if (line.startsWith('## ')) { fragment.append(element('h4', 'lesson-subheading', line.slice(3))); list = null; }
    else if (/^[-*]\s/.test(line)) {
      if (!list) { list = element('ul', 'lesson-list'); fragment.append(list); }
      list.append(element('li', '', line.slice(2)));
    } else { fragment.append(element('p', 'lesson-paragraph', line)); list = null; }
  }
  return fragment;
}

async function showStudy() {
  setHeading('study');
  const stages = await api('/api/curriculum');
  clearContent();
  if (!stages.length) return empty('还没有课程。运行 npm run learning:seed 加载不含真实公司资料的安全入门课程。');
  const allLessons = stages.flatMap((stage) => stage.lessons);
  const done = allLessons.filter((lesson) => lesson.status === 'understood').length;
  const progress = element('section', 'progress-strip');
  const meter = element('div', 'progress-meter');
  const fill = element('span');
  fill.style.width = `${allLessons.length ? Math.round(done / allLessons.length * 100) : 0}%`;
  meter.append(fill);
  progress.append(element('p', 'kicker', 'LOCAL PROGRESS'), element('strong', '', `${done} / ${allLessons.length} 节已理解`), meter);
  content.append(progress);
  stages.forEach((stage, index) => {
    const section = element('section', 'stage-block');
    const head = element('div', 'stage-heading');
    const copy = element('div', 'stage-copy');
    copy.append(element('p', 'kicker', 'STAGE'), element('h3', '', stage.title), element('p', 'stage-intro', stage.intro || stage.goal || ''));
    head.append(element('span', 'stage-number', String(index + 1).padStart(2, '0')), copy);
    section.append(head);
    const lessons = element('div', 'lesson-grid');
    stage.lessons.forEach((lesson) => {
      const button = element('button', `lesson-ticket state-${lesson.status}`);
      button.type = 'button';
      button.append(element('span', 'lesson-state', statusNames[lesson.status] || lesson.status), element('strong', '', lesson.title),
        element('span', 'lesson-brief', lesson.brief || '打开课节'),
        element('span', 'lesson-time', `${lesson.estimatedMinutes} 分钟 · ${lesson.reviewStatus === 'draft' ? '课程草稿' : '已审核'}`));
      button.addEventListener('click', () => showLesson(lesson.lessonId).catch((error) => empty(error.message)));
      lessons.append(button);
    });
    section.append(lessons); content.append(section);
  });
}

async function showLesson(lessonId) {
  const lesson = await api(`/api/lessons/${encodeURIComponent(lessonId)}`);
  setHeading('lesson', lesson.title); clearContent();
  const back = element('button', 'back-button', '← 返回学习路径');
  back.type = 'button'; back.addEventListener('click', () => showStudy().catch((error) => empty(error.message)));
  const article = element('article', 'lesson-sheet');
  const trail = element('div', 'lesson-trail');
  trail.append(element('span', 'status-pill', statusNames[lesson.status]), element('span', '', `${lesson.estimatedMinutes} 分钟`),
    element('span', lesson.reviewStatus === 'draft' ? 'draft-pill' : 'status-pill', lesson.reviewStatus === 'draft' ? '课程草稿' : '已审核'));
  article.append(trail, element('p', 'lesson-lead', lesson.brief || ''), bodyFragment(lesson.body));
  if (lesson.remember) {
    const remember = element('aside', 'remember-box');
    remember.append(element('p', 'kicker', 'TAKEAWAY'), element('strong', '', lesson.remember)); article.append(remember);
  }
  const evidence = element('section', 'lesson-panel'); evidence.append(element('h3', '', '证据轨迹'));
  if (!lesson.evidence.length) evidence.append(element('p', 'muted', '这节安全入门课程没有绑定公司原件。导入资料后可逐条建立已验证映射。'));
  lesson.evidence.forEach((item) => evidence.append(card({
    meta: item.resolutionStatus === 'resolved' ? 'VERIFIED EVIDENCE' : 'PENDING MAP',
    title: item.sourceTitle || item.sourceHint || '待映射来源',
    excerpt: item.resolutionStatus === 'resolved' ? '已绑定当前目录中的版本与证据块' : '这只是旧课程中的定位线索，不是已验证引用。',
    locator: item.resolutionStatus === 'resolved' ? `${item.versionId} / ${item.blockId} / ${JSON.stringify(item.locator)}` : JSON.stringify(item.locatorHint),
    bad: item.resolutionStatus !== 'resolved',
  })));
  if (lesson.externalReferences.length) {
    const links = element('ul', 'reference-list');
    lesson.externalReferences.forEach((ref) => {
      const link = element('a', '', ref.title); link.href = ref.url; link.rel = 'noreferrer'; link.target = '_blank';
      const item = element('li'); item.append(link, element('span', 'draft-pill', ref.reviewStatus)); links.append(item);
    });
    evidence.append(links);
  }
  const practice = element('section', 'lesson-panel practice-panel'); practice.append(element('h3', '', '主动回忆与笔记'));
  const feedback = element('p', 'quiz-feedback');
  if (lesson.quiz) {
    practice.append(element('p', 'quiz-question', lesson.quiz.question));
    const choices = element('div', 'quiz-options');
    lesson.quiz.options.forEach((option, index) => {
      const label = element('label', 'quiz-option');
      const input = document.createElement('input'); input.type = 'radio'; input.name = 'quiz-answer'; input.value = index;
      if (lesson.lastAnswerIndex === index) input.checked = true;
      label.append(input, element('span', '', option)); choices.append(label);
    });
    const check = element('button', 'primary-button', '核对答案'); check.type = 'button';
    check.addEventListener('click', async () => {
      const selected = practice.querySelector('input[name="quiz-answer"]:checked');
      if (!selected) { feedback.textContent = '请先选择一个答案。'; return; }
      const result = await post(`/api/lessons/${encodeURIComponent(lessonId)}/progress`, { answerIndex: Number(selected.value), status: 'learning' });
      feedback.className = result.lastAnswerCorrect ? 'quiz-feedback correct' : 'quiz-feedback incorrect';
      feedback.textContent = `${result.lastAnswerCorrect ? '回答正确。' : '还需要再想一遍。'} ${result.explanation}`;
      renderSummary(await api('/api/summary'));
    });
    practice.append(choices, check, feedback);
  }
  const noteLabel = element('label', 'note-label', '用自己的话记下理解或疑问');
  const note = element('textarea', 'note-input'); note.value = lesson.note || ''; note.rows = 5;
  const actions = element('div', 'lesson-actions');
  [['learning', '保存为学习中'], ['understood', '标记已理解'], ['review_due', '加入复习']].forEach(([status, label]) => {
    const button = element('button', status === 'understood' ? 'primary-button' : 'secondary-button', label); button.type = 'button';
    button.addEventListener('click', async () => {
      await post(`/api/lessons/${encodeURIComponent(lessonId)}/progress`, { status, note: note.value });
      await showLesson(lessonId); renderSummary(await api('/api/summary'));
    }); actions.append(button);
  });
  practice.append(noteLabel, note, actions); content.append(back, article, evidence, practice);
}

async function showGlossary(query = '') {
  setHeading('glossary'); const rows = await api(`/api/glossary?q=${encodeURIComponent(query)}`); clearContent();
  const form = element('form', 'glossary-search');
  const input = element('input'); input.name = 'glossary'; input.value = query; input.placeholder = '筛选术语、白话名或含义';
  const button = element('button', 'primary-button', '筛选'); button.type = 'submit'; form.append(input, button);
  form.addEventListener('submit', (event) => { event.preventDefault(); showGlossary(input.value).catch((error) => empty(error.message)); });
  content.append(form);
  if (!rows.length) { content.append(element('p', 'empty', '没有匹配的词条。')); return; }
  const grid = element('div', 'glossary-grid');
  rows.forEach((row) => {
    const item = element('article', 'term-card');
    item.append(element('p', 'card-meta', `${row.category || '未分类'} · ${row.reviewStatus}`), element('h3', '', row.term),
      element('p', 'plain-name', row.plainName || ''), element('p', '', row.meaning));
    if (row.lessonId) {
      const open = element('button', 'text-button', '打开关联课节 →'); open.type = 'button';
      open.addEventListener('click', () => showLesson(row.lessonId).catch((error) => empty(error.message))); item.append(open);
    }
    grid.append(item);
  }); content.append(grid);
}

async function showSources() {
  setHeading('sources'); const rows = await api('/api/sources'); clearContent();
  if (!rows.length) return empty('还没有资料。先通过受控接收命令保存一份脱敏文件。');
  rows.forEach((row) => content.append(card({ meta: `${row.sourceType} · ${row.validityStatus}`, title: row.title,
    excerpt: `处理：${row.processingStatus}　审核：${row.reviewStatus}`,
    locator: `${row.sourceId} / ${row.versionId}${row.versionLabel ? ` / ${row.versionLabel}` : ''}`, bad: row.processingStatus === 'failed' })));
}
async function showMemories() {
  setHeading('memories'); const rows = await api('/api/memories'); clearContent();
  if (!rows.length) return empty('没有活动记忆。含糊或敏感内容应先作为候选保存。');
  rows.forEach((row) => content.append(card({ meta: `${row.category} · ${row.status}`, title: row.content,
    excerpt: row.sourceMessageId ? `来源消息：${row.sourceMessageId}` : '未关联消息', locator: row.memoryId, bad: row.status === 'candidate' })));
}
async function showLearning() {
  setHeading('learning'); const rows = await api('/api/learning'); clearContent();
  if (!rows.length) return empty('还没有自由学习日志。课程内笔记和自测状态保存在“学习路径”中。');
  rows.forEach((row) => content.append(card({ meta: `${row.occurred_on} · ${row.status}`, title: row.topic,
    excerpt: row.understanding || row.question || '尚未记录理解或问题', locator: row.review_on ? `复习日期 ${row.review_on}` : row.learning_log_id,
    bad: row.status === 'review_due' })));
}
async function showGovernance() {
  setHeading('governance'); const [data, issues] = await Promise.all([api('/api/governance'), api('/api/learning-issues')]); clearContent();
  const entries = [
    ...issues.map((row) => ({ meta: `LEARNING ISSUE · ${row.riskLevel}`, title: row.title, excerpt: row.questionToResolve || row.learningGuidance, locator: row.sourceLocator || row.issueId })),
    ...data.conflicts.map((row) => ({ meta: 'OPEN CONFLICT', title: row.title, excerpt: '不同版本尚未完成授权裁决', locator: row.conflict_group_id })),
    ...data.failedJobs.map((row) => ({ meta: 'FAILED JOB', title: row.job_type, excerpt: row.last_error, locator: row.job_id })),
    ...data.failedExternalProcessing.map((row) => ({ meta: `EXTERNAL ${row.capability.toUpperCase()} FAILED`, title: row.model,
      excerpt: row.errorMessage || '外部处理失败', locator: `${row.runId} / ${row.versionId}` })),
    ...data.invalidCitations.map((row) => ({ meta: 'BROKEN CITATION', title: row.citationId, excerpt: '原件、正文或定位校验失败', locator: row.blockId })),
  ];
  if (!entries.length) return empty('当前没有开放冲突、失败任务、学习问题或失效引用。');
  entries.forEach((entry) => content.append(card({ ...entry, bad: true })));
}
async function showUsage() {
  setHeading('usage'); const rows = await api('/api/usage'); clearContent();
  if (!rows.length) return empty('还没有用量记录。只有实际发生的处理量和成本才进入台账。');
  rows.forEach((row) => content.append(card({ meta: `${row.provider} · ${row.metric}`, title: `${row.quantity} ${row.unit}`,
    excerpt: row.currency ? `已记录成本：${row.costMinor} ${row.currency} 最小货币单位` : '未记录外部费用', locator: 'usage_ledger / 当前项目汇总' })));
}
async function search(query) {
  setHeading('search');
  const [evidenceRows, learningRows] = await Promise.all([
    api(`/api/search?q=${encodeURIComponent(query)}`), api(`/api/learning-search?q=${encodeURIComponent(query)}`),
  ]); clearContent();
  if (!evidenceRows.length && !learningRows.length) return empty('没有命中课程、词典或当前有效版本。');
  learningRows.forEach((row) => {
    const node = card({ meta: `LEARNING · ${row.kind}`, title: row.title, excerpt: row.excerpt, locator: `${row.kind} / ${row.id}` });
    if (row.kind === 'lesson') { node.classList.add('clickable-card'); node.addEventListener('click', () => showLesson(row.id).catch((error) => empty(error.message))); }
    content.append(node);
  });
  evidenceRows.forEach((row) => content.append(card({ meta: `EVIDENCE · ${row.sourceType} · ${row.sourceId}`, title: row.title,
    excerpt: row.text, locator: `${row.versionId} / ${row.blockId} / ${JSON.stringify(row.locator)} / ${row.originalRelativePath}` })));
}

document.querySelector('#search-form').addEventListener('submit', (event) => {
  event.preventDefault(); search(new FormData(event.currentTarget).get('query')).catch((error) => empty(error.message));
});
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button));
  const actions = { study: showStudy, glossary: showGlossary, sources: showSources, memories: showMemories, learning: showLearning, usage: showUsage, governance: showGovernance };
  actions[button.dataset.view]().catch((error) => empty(error.message));
}));
api('/api/bootstrap').then((data) => { csrfToken = data.csrfToken; renderSummary(data.summary); return showStudy(); }).catch((error) => empty(error.message));
