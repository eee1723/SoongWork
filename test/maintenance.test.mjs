import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureProjectDirs } from '../src/lib/project.mjs';
import { openCatalog } from '../src/lib/catalog.mjs';
import { intakeMessage } from '../src/lib/intake.mjs';
import { citeClaim, createClaim, indexPlainText, searchEvidence } from '../src/lib/evidence.mjs';
import { createBackup, exportCatalog, integrityReport, restoreBackup } from '../src/lib/maintenance.mjs';

const config = {
  schemaVersion: 4,
  projectId: 'maintenance-test',
  name: '维护测试',
  dataPolicy: { defaultConfidentiality: 'internal' },
};

async function preparedProject() {
  const root = await mkdtemp(join(tmpdir(), 'pet-maintenance-'));
  await ensureProjectDirs(root);
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'config', 'project.json'), `${JSON.stringify(config)}\n`, 'utf8');
  const db = openCatalog(root, config);
  const intake = await intakeMessage({ root, config, db, messageId: 'backup-msg', text: '备份恢复证据文本' });
  await indexPlainText({ root, db, versionId: intake.versionId });
  const hit = searchEvidence({ db, query: '恢复证据' })[0];
  const claim = createClaim({ db, statement: '存在一条备份测试证据。' });
  citeClaim({ db, claimId: claim.claimId, blockId: hit.blockId });
  return { root, db, intake };
}

test('integrity, JSONL export, online backup and empty-environment restore form a closed loop', async (t) => {
  const { root, db } = await preparedProject();
  t.after(() => db.close());
  const integrity = await integrityReport({ root, db });
  assert.equal(integrity.ok, true);
  assert.equal(integrity.counts.citations, 1);

  const exported = await exportCatalog({ root, db });
  const lines = (await readFile(exported.file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'export_header');
  assert.ok(lines.some((line) => line.type === 'citation'));

  const backup = await createBackup({ root, db });
  const target = join(await mkdtemp(join(tmpdir(), 'pet-restore-parent-')), 'restored');
  const restored = await restoreBackup({ backupDir: backup.directory, targetDir: target });
  assert.equal(restored.verified, true);
  const restoredDb = new DatabaseSync(join(target, 'catalog.sqlite'), { readOnly: true });
  try {
    assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM source_version').get().count, 1);
    assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM citation').get().count, 1);
  } finally {
    restoredDb.close();
  }
});

test('integrity report blocks a modified original', async (t) => {
  const { root, db, intake } = await preparedProject();
  t.after(() => db.close());
  await writeFile(join(root, intake.originalRelativePath), '被修改', 'utf8');
  const report = await integrityReport({ root, db });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.kind === 'original_hash'));
});
