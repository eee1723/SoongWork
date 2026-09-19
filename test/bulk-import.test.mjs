import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureProjectDirs } from '../src/lib/project.mjs';
import { openCatalog } from '../src/lib/catalog.mjs';
import { importDirectory } from '../src/lib/bulk-import.mjs';
import { searchEvidence } from '../src/lib/evidence.mjs';

const config = {
  schemaVersion: 6,
  projectId: 'bulk-import-test',
  dataPolicy: { defaultConfidentiality: 'synthetic', externalTransmissionAllowed: false, realCompanyDataApproved: false },
  network: { mode: 'deny-by-default', approvedServices: [] },
};

test('directory import indexes local formats, stores media and produces a resumable report', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pet-bulk-project-'));
  const input = await mkdtemp(join(tmpdir(), 'pet-bulk-input-'));
  await ensureProjectDirs(root);
  const db = openCatalog(root, config);
  t.after(() => db.close());
  await mkdir(join(input, 'nested'));
  await writeFile(join(input, 'guide.md'), '# 合成指南\n核对样本编号。', 'utf8');
  await writeFile(join(input, 'picture.jpg'), Buffer.from('synthetic-image'));
  await writeFile(join(input, 'nested', 'recording.wav'), Buffer.from('synthetic-audio'));
  await writeFile(join(input, 'ignored.exe'), Buffer.from('unsupported'));

  const first = await importDirectory({ root, db, config, sourceDir: input, recursive: true, externalMedia: false });
  assert.equal(first.ok, true);
  assert.deepEqual(first.totals, { discovered: 4, supported: 3, received: 3, indexed: 1, storedOnly: 2, skipped: 1, failed: 0 });
  assert.equal(searchEvidence({ db, query: '样本编号' }).length, 1);
  assert.equal(JSON.parse(await readFile(join(root, first.reportRelativePath), 'utf8')).importRunId, first.importRunId);

  const second = await importDirectory({ root, db, config, sourceDir: input, recursive: true, externalMedia: false });
  assert.equal(second.files.filter((item) => item.duplicateContent).length, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM source').get().count, 3);
});

test('directory import refuses project-generated trees', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pet-bulk-generated-'));
  await ensureProjectDirs(root);
  const db = openCatalog(root, config);
  t.after(() => db.close());
  await assert.rejects(() => importDirectory({ root, db, config, sourceDir: join(root, 'sources') }), /项目生成目录/);
});

test('PPT image OCR requires the explicit external-media switch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pet-bulk-ppt-gate-'));
  const input = await mkdtemp(join(tmpdir(), 'pet-bulk-ppt-input-'));
  await ensureProjectDirs(root);
  const db = openCatalog(root, config);
  t.after(() => db.close());
  await assert.rejects(() => importDirectory({
    root, db, config, sourceDir: input, externalMedia: false, pptImageOcr: true,
  }), /要求 externalMedia=true/);
});
