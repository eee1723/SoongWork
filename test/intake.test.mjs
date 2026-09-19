import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { ensureProjectDirs } from '../src/lib/project.mjs';
import { openCatalog } from '../src/lib/catalog.mjs';
import { intakeFile, intakeMessage } from '../src/lib/intake.mjs';
import { citeClaim, createClaim, indexPlainText, searchEvidence, verifyCitations } from '../src/lib/evidence.mjs';
import { parseVersion } from '../src/lib/parsers.mjs';
import {
  addConcept, addLearningLog, addMemory, addWorkLog, createConflict, enqueueParse, listMemories,
  relateConcepts, resolveConflict, reviewMemory, runJobs,
} from '../src/lib/state.mjs';

const config = {
  schemaVersion: 5,
  projectId: 'test-project',
  dataPolicy: { defaultConfidentiality: 'internal' },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pet-learning-'));
  await ensureProjectDirs(root);
  const db = openCatalog(root, config);
  return { root, db };
}

function minimalPdf(text) {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 18 Tf 50 100 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

test('file intake preserves bytes, manifest and catalog identity', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const inputDir = join(root, 'outside-input');
  await mkdir(inputDir);
  const input = join(inputDir, 'sample.txt');
  await writeFile(input, '犬猫脱敏示例\n', 'utf8');

  const result = await intakeFile({ root, config, db, file: input, title: '脱敏样本' });
  assert.equal(result.duplicateContent, false);
  assert.match(result.sourceId, /^SRC-/);
  assert.match(result.versionId, /^VER-/);
  assert.equal(await readFile(join(root, result.originalRelativePath), 'utf8'), '犬猫脱敏示例\n');

  const manifestPath = join(root, 'sources', result.sourceId, result.versionId, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.sha256, result.sha256);
  assert.equal(manifest.processingStatus, 'received');
  assert.equal(manifest.reviewStatus, 'draft');
});

test('duplicate content reuses source version but records a new submission', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const input = join(root, 'same.txt');
  await writeFile(input, 'same content', 'utf8');
  const first = await intakeFile({ root, config, db, file: input });
  const second = await intakeFile({ root, config, db, file: input });

  assert.equal(second.duplicateContent, true);
  assert.equal(second.sourceId, first.sourceId);
  assert.equal(second.versionId, first.versionId);
  assert.notEqual(second.submissionId, first.submissionId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM source_version').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM intake_submission').get().count, 2);
});

test('message intake keeps message identity and does not claim indexing', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const result = await intakeMessage({
    root, config, db, messageId: 'msg-001', text: '这是一条脱敏消息',
  });
  const source = db.prepare('SELECT * FROM source WHERE source_id = ?').get(result.sourceId);
  assert.equal(source.source_type, 'message');
  assert.equal(source.original_reference, 'msg-001');
  assert.equal(result.processingStatus, 'received');
  assert.equal(result.reviewStatus, 'draft');
});

test('catalog refuses a different project identity', async () => {
  const { root, db } = await fixture();
  db.close();
  assert.throws(() => openCatalog(root, { ...config, projectId: 'other-project' }), /拒绝/);
});

test('plain text indexing is idempotent and finds two-character Chinese terms', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const intake = await intakeMessage({
    root,
    config,
    db,
    messageId: 'msg-search-001',
    text: '# 培训记录\n\n犬猫检验流程需要核对样本编号。\n\n否定词和单位必须复核。',
  });

  const first = await indexPlainText({ root, db, versionId: intake.versionId });
  const second = await indexPlainText({ root, db, versionId: intake.versionId });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.blockCount, first.blockCount);

  const shortTerm = searchEvidence({ db, query: '检验' });
  assert.equal(shortTerm.length, 1);
  assert.equal(shortTerm[0].versionId, intake.versionId);
  assert.deepEqual(shortTerm[0].locator.headingPath, ['培训记录']);

  const trigram = searchEvidence({ db, query: '样本编号' });
  assert.equal(trigram.length, 1);
  assert.match(trigram[0].text, /样本编号/);
});

test('citation verification detects source or excerpt tampering', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const intake = await intakeMessage({
    root, config, db, messageId: 'msg-citation-001', text: '先核对样本编号，再记录结果。',
  });
  await indexPlainText({ root, db, versionId: intake.versionId });
  const hit = searchEvidence({ db, query: '样本编号' })[0];
  const claim = createClaim({ db, statement: '流程要求核对样本编号。', risk: 'medium' });
  const citation = citeClaim({ db, claimId: claim.claimId, blockId: hit.blockId });

  const valid = await verifyCitations({ root, db, citationId: citation.citationId });
  assert.equal(valid[0].valid, true);

  db.prepare('UPDATE block SET text = ? WHERE block_id = ?').run('被篡改的正文', hit.blockId);
  const invalid = await verifyCitations({ root, db, citationId: citation.citationId });
  assert.equal(invalid[0].valid, false);
  assert.equal(invalid[0].checks.excerptMatches, false);
});

test('schema v1 catalog migrates transactionally to the current schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pet-learning-migration-'));
  await ensureProjectDirs(root);
  const v1 = openCatalog(root, { ...config, schemaVersion: 1 });
  v1.close();
  const v2 = openCatalog(root, config);
  try {
    assert.equal(v2.prepare('SELECT schema_version AS version FROM project_meta').get().version, 5);
    assert.doesNotThrow(() => v2.prepare('SELECT COUNT(*) FROM artifact').get());
    assert.doesNotThrow(() => v2.prepare('SELECT COUNT(*) FROM memory_item').get());
    assert.doesNotThrow(() => v2.prepare('SELECT COUNT(*) FROM usage_ledger').get());
  } finally {
    v2.close();
  }
});

test('indexed evidence survives catalog close and a fresh session', async () => {
  const { root, db } = await fixture();
  const intake = await intakeMessage({
    root, config, db, messageId: 'msg-restart-001', text: '复盘记录：样本标签必须清晰。',
  });
  await indexPlainText({ root, db, versionId: intake.versionId });
  db.close();

  const reopened = openCatalog(root, config);
  try {
    const results = searchEvidence({ db: reopened, query: '样本标签' });
    assert.equal(results.length, 1);
    assert.equal(results[0].versionId, intake.versionId);
    assert.equal(results[0].sourceType, 'message');
    assert.equal(results[0].originalRelativePath, intake.originalRelativePath);
    assert.equal(await readFile(join(root, results[0].originalRelativePath), 'utf8'), '复盘记录：样本标签必须清晰。\n');
  } finally {
    reopened.close();
  }
});

test('PPTX parser preserves slide and notes locators', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:t>犬猫疫苗培训</a:t><a:t>核对批号</a:t></p:sld>');
  zip.file('ppt/notesSlides/notesSlide1.xml', '<p:notes xmlns:p="p" xmlns:a="a"><a:t>讲者备注：仅限脱敏演示</a:t></p:notes>');
  zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="rId1" Target="../media/image1.png"/></Relationships>');
  zip.file('ppt/media/image1.png', Buffer.from('synthetic-image'));
  const file = join(root, 'training.pptx');
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const intake = await intakeFile({ root, config, db, file, title: '虚构培训' });
  const parsed = await parseVersion({ root, db, versionId: intake.versionId });
  assert.equal(parsed.blockCount, 2);
  assert.equal(parsed.imageCount, 1);
  assert.equal(searchEvidence({ db, query: '核对批号' })[0].locator.slide, 1);
  assert.equal(searchEvidence({ db, query: '讲者备注' })[0].locator.contentType, 'notes');
  const derived = db.prepare('SELECT relative_path AS relativePath, locator_json AS locatorJson FROM derived_file').get();
  assert.deepEqual(JSON.parse(derived.locatorJson), { kind: 'slide-image', slides: [1] });
  assert.deepEqual(await readFile(join(root, derived.relativePath)), Buffer.from('synthetic-image'));
});

test('XLSX parser keeps sheet names and cell-range locators', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="脱敏台账" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/sharedStrings.xml', '<sst><si><t>样本编号</t></si><si><t>合成-001</t></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>结论</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>');
  const file = join(root, 'ledger.xlsx');
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const intake = await intakeFile({ root, config, db, file, title: '合成台账' });
  const parsed = await parseVersion({ root, db, versionId: intake.versionId });
  assert.equal(parsed.blockCount, 2);
  const result = searchEvidence({ db, query: '合成-001' })[0];
  assert.deepEqual(result.locator, { kind: 'cell_range', sheet: '脱敏台账', row: 1, startCell: 'A1', endCell: 'B1' });
});

test('DOCX parser extracts paragraphs with stable paragraph locators', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段：检查样本标签</w:t></w:r></w:p><w:p><w:r><w:t>第二段：记录结果</w:t></w:r></w:p></w:body></w:document>`);
  const file = join(root, 'procedure.docx');
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const intake = await intakeFile({ root, config, db, file });
  await parseVersion({ root, db, versionId: intake.versionId });
  const result = searchEvidence({ db, query: '样本标签' })[0];
  assert.equal(result.locator.kind, 'paragraph');
  assert.equal(result.locator.paragraph, 1);
});

test('HTML parser strips executable content and VTT keeps time ranges', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const html = join(root, 'snapshot.html');
  await writeFile(html, '<html><script>恶意指令不可索引</script><body><h1>公开资料快照</h1><p>犬猫护理基础</p></body></html>', 'utf8');
  const htmlIntake = await intakeFile({ root, config, db, file: html });
  await parseVersion({ root, db, versionId: htmlIntake.versionId });
  assert.equal(searchEvidence({ db, query: '护理基础' }).length, 1);
  assert.equal(searchEvidence({ db, query: '恶意指令' }).length, 0);

  const vtt = join(root, 'training.vtt');
  await writeFile(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n先核对动物身份\n', 'utf8');
  const vttIntake = await intakeFile({ root, config, db, file: vtt, sourceType: 'transcript' });
  await parseVersion({ root, db, versionId: vttIntake.versionId });
  const cue = searchEvidence({ db, query: '动物身份' })[0];
  assert.deepEqual(cue.locator, { kind: 'time', startMs: 1000, endMs: 3500 });
});

test('PDF parser extracts page text with a physical page locator', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const file = join(root, 'sample.pdf');
  await writeFile(file, minimalPdf('Sample identifier check'));
  const intake = await intakeFile({ root, config, db, file });
  const parsed = await parseVersion({ root, db, versionId: intake.versionId });
  assert.equal(parsed.blockCount, 1);
  const result = searchEvidence({ db, query: 'identifier check' })[0];
  assert.equal(result.locator.kind, 'page');
  assert.equal(result.locator.page, 1);
});

test('a new source version can explicitly supersede an older version', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const firstFile = join(root, 'policy-v1.md');
  const secondFile = join(root, 'policy-v2.md');
  await writeFile(firstFile, '旧版虚构流程', 'utf8');
  await writeFile(secondFile, '新版虚构流程', 'utf8');
  const first = await intakeFile({ root, config, db, file: firstFile, versionLabel: 'v1' });
  const second = await intakeFile({ root, config, db, file: secondFile, versionLabel: 'v2',
    sourceId: first.sourceId, supersedesVersionId: first.versionId });
  assert.equal(second.sourceId, first.sourceId);
  assert.equal(db.prepare('SELECT validity_status AS status FROM source_version WHERE version_id = ?').get(first.versionId).status, 'superseded');
  assert.equal(db.prepare('SELECT relation_type AS type FROM source_relation WHERE from_version_id = ?').get(second.versionId).type, 'supersedes');
});

test('conflicts, concepts, memories, work and learning records retain review boundaries', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const a = join(root, 'a.txt');
  const b = join(root, 'b.txt');
  await writeFile(a, '方案甲', 'utf8');
  await writeFile(b, '方案乙', 'utf8');
  const va = await intakeFile({ root, config, db, file: a });
  const vb = await intakeFile({ root, config, db, file: b });
  const conflict = createConflict({ db, title: '虚构版本冲突', versionIds: [va.versionId, vb.versionId] });
  assert.equal(resolveConflict({ db, conflictGroupId: conflict.conflictGroupId, resolution: '仅用于测试' }).status, 'resolved');

  const c1 = addConcept({ db, name: '样本', aliases: ['标本'] });
  const c2 = addConcept({ db, name: '标签' });
  assert.equal(relateConcepts({ db, fromConceptId: c1.conceptId, toConceptId: c2.conceptId, type: 'related_to' }).reviewStatus, 'draft');

  const candidate = addMemory({ db, config, category: 'preference', content: '先例子后概念' });
  assert.equal(candidate.status, 'candidate');
  assert.equal(reviewMemory({ db, memoryId: candidate.memoryId, action: 'confirm' }).status, 'confirmed');
  const replacement = reviewMemory({ db, memoryId: candidate.memoryId, action: 'replace', replacement: '先结论后例子' });
  assert.equal(replacement.replacesMemoryId, candidate.memoryId);
  assert.equal(listMemories({ db, config }).length, 1);

  assert.match(addWorkLog({ db, date: '2026-09-19', task: '完成脱敏测试' }).workLogId, /^WRK-/);
  assert.match(addLearningLog({ db, date: '2026-09-19', topic: '样本管理', status: 'learning' }).learningLogId, /^LRN-/);
});

test('parse jobs are idempotent and persist retry state', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const intake = await intakeMessage({ root, config, db, messageId: 'msg-job-001', text: '任务队列测试文本' });
  const first = enqueueParse({ db, projectId: config.projectId, versionId: intake.versionId });
  const duplicate = enqueueParse({ db, projectId: config.projectId, versionId: intake.versionId });
  assert.equal(duplicate.jobId, first.jobId);
  assert.equal(duplicate.duplicate, true);
  const results = await runJobs({ root, db });
  assert.equal(results[0].status, 'succeeded');
  assert.equal(db.prepare('SELECT attempts FROM processing_job WHERE job_id = ?').get(first.jobId).attempts, 1);
});
