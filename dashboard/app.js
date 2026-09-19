let csrfToken = '';
const content = document.querySelector('#content');
const viewTitle = document.querySelector('#view-title');
const viewKicker = document.querySelector('#view-kicker');

const labels = {
  sources: ['SOURCE REGISTER', '资料版本'],
  memories: ['MEMORY REVIEW', '候选记忆'],
  learning: ['LEARNING QUEUE', '学习复习'],
  usage: ['USAGE LEDGER', '用量台账'],
  governance: ['GOVERNANCE WATCH', '治理异常'],
  search: ['EVIDENCE RESULTS', '证据检索结果'],
};

function setHeading(view) {
  [viewKicker.textContent, viewTitle.textContent] = labels[view];
}

function clearContent() {
  content.replaceChildren();
}

function empty(message) {
  clearContent();
  const node = document.createElement('p');
  node.className = 'empty';
  node.textContent = message;
  content.append(node);
}

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

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function renderSummary(summary) {
  const fields = [
    ['来源', summary.sources], ['版本', summary.versions], ['已索引', summary.indexed],
    ['待审结论', summary.draftClaims], ['开放冲突', summary.openConflicts],
    ['候选记忆', summary.candidateMemories], ['待复习', summary.reviewDue],
    ['用量记录', summary.usageRecords], ['已删墓碑', summary.deletedSources],
  ];
  const ledger = document.querySelector('#summary');
  ledger.replaceChildren(...fields.map(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const data = document.createElement('dd');
    term.textContent = label;
    data.textContent = value;
    row.append(term, data);
    return row;
  }));
  document.querySelector('#updated').textContent = `更新 ${new Date(summary.updatedAt).toLocaleString('zh-CN')}`;
}

async function showSources() {
  setHeading('sources');
  const rows = await api('/api/sources');
  clearContent();
  if (!rows.length) return empty('还没有资料。先通过受控接收命令保存一份脱敏文件。');
  rows.forEach((row) => content.append(card({
    meta: `${row.sourceType} · ${row.validityStatus}`,
    title: row.title,
    excerpt: `处理：${row.processingStatus}　审核：${row.reviewStatus}`,
    locator: `${row.sourceId} / ${row.versionId}${row.versionLabel ? ` / ${row.versionLabel}` : ''}`,
    bad: row.processingStatus === 'failed',
  })));
}

async function showMemories() {
  setHeading('memories');
  const rows = await api('/api/memories');
  clearContent();
  if (!rows.length) return empty('没有活动记忆。含糊或敏感内容应先作为候选保存。');
  rows.forEach((row) => content.append(card({
    meta: `${row.category} · ${row.status}`,
    title: row.content,
    excerpt: row.sourceMessageId ? `来源消息：${row.sourceMessageId}` : '未关联消息',
    locator: row.memoryId,
    bad: row.status === 'candidate',
  })));
}

async function showLearning() {
  setHeading('learning');
  const rows = await api('/api/learning');
  clearContent();
  if (!rows.length) return empty('还没有学习记录。自测结果而不是“读过”决定掌握状态。');
  rows.forEach((row) => content.append(card({
    meta: `${row.occurred_on} · ${row.status}`,
    title: row.topic,
    excerpt: row.understanding || row.question || '尚未记录理解或问题',
    locator: row.review_on ? `复习日期 ${row.review_on}` : row.learning_log_id,
    bad: row.status === 'review_due',
  })));
}

async function showGovernance() {
  setHeading('governance');
  const data = await api('/api/governance');
  clearContent();
  const entries = [
    ...data.conflicts.map((row) => ({ meta: 'OPEN CONFLICT', title: row.title, excerpt: '不同版本尚未完成授权裁决', locator: row.conflict_group_id })),
    ...data.failedJobs.map((row) => ({ meta: 'FAILED JOB', title: row.job_type, excerpt: row.last_error, locator: row.job_id })),
    ...data.invalidCitations.map((row) => ({ meta: 'BROKEN CITATION', title: row.citationId, excerpt: '原件、正文或定位校验失败', locator: row.blockId })),
  ];
  if (!entries.length) return empty('当前没有开放冲突、失败任务或失效引用。');
  entries.forEach((entry) => content.append(card({ ...entry, bad: true })));
}

async function showUsage() {
  setHeading('usage');
  const rows = await api('/api/usage');
  clearContent();
  if (!rows.length) return empty('还没有用量记录。只有实际发生的处理量和成本才进入台账。');
  rows.forEach((row) => content.append(card({
    meta: `${row.provider} · ${row.metric}`,
    title: `${row.quantity} ${row.unit}`,
    excerpt: row.currency ? `已记录成本：${row.costMinor} ${row.currency} 最小货币单位` : '未记录外部费用',
    locator: 'usage_ledger / 当前项目汇总',
  })));
}

async function search(query) {
  setHeading('search');
  const rows = await api(`/api/search?q=${encodeURIComponent(query)}`);
  clearContent();
  if (!rows.length) return empty('没有命中当前有效版本。尝试别名、英文词或更短的准确片段。');
  rows.forEach((row) => content.append(card({
    meta: `${row.sourceType} · ${row.sourceId}`,
    title: row.title,
    excerpt: row.text,
    locator: `${row.versionId} / ${row.blockId} / ${JSON.stringify(row.locator)} / ${row.originalRelativePath}`,
  })));
}

document.querySelector('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  search(new FormData(event.currentTarget).get('query')).catch((error) => empty(error.message));
});

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button));
  const actions = { sources: showSources, memories: showMemories, learning: showLearning, usage: showUsage, governance: showGovernance };
  actions[button.dataset.view]().catch((error) => empty(error.message));
}));

api('/api/bootstrap').then((data) => {
  csrfToken = data.csrfToken;
  renderSummary(data.summary);
  return showSources();
}).catch((error) => empty(error.message));
