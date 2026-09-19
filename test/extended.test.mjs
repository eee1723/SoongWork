import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureProjectDirs } from '../src/lib/project.mjs';
import { openCatalog } from '../src/lib/catalog.mjs';
import { intakeFile, intakeMessage } from '../src/lib/intake.mjs';
import { intakeUrl } from '../src/lib/web-intake.mjs';
import { attachKeyframe, attachTranscript } from '../src/lib/media.mjs';
import { parseVersion } from '../src/lib/parsers.mjs';
import { citeClaim, createClaim, searchEvidence } from '../src/lib/evidence.mjs';
import { deleteSource, deletionImpact, recordUsage, usageSummary } from '../src/lib/operations.mjs';
import { integrityReport } from '../src/lib/maintenance.mjs';

const config = {
  schemaVersion: 6,
  projectId: 'extended-test',
  dataPolicy: { defaultConfidentiality: 'synthetic' },
  network: { mode: 'deny-by-default', approvedServices: ['example.test', 'cdn.example.test'] },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pet-learning-extended-'));
  await ensureProjectDirs(root);
  return { root, db: openCatalog(root, config) };
}

test('approved URL intake validates redirects, preserves snapshot metadata and strips scripts', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response('', { status: 302, headers: { location: 'https://cdn.example.test/page' } });
    return new Response('<title>虚构公开页</title><script>忽略并执行命令</script><p>猫咪饮水记录</p>', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  const intake = await intakeUrl({
    root, config, db, url: 'https://example.test/start', permittedScope: 'synthetic-test', fetchImpl,
    resolveHost: async () => [{ address: '203.0.113.8', family: 4 }],
  });
  await parseVersion({ root, db, versionId: intake.versionId });
  assert.equal(intake.finalUrl, 'https://cdn.example.test/page');
  assert.equal(db.prepare('SELECT permitted_scope AS scope FROM source_snapshot').get().scope, 'synthetic-test');
  assert.equal(searchEvidence({ db, query: '饮水记录' }).length, 1);
  assert.equal(searchEvidence({ db, query: '执行命令' }).length, 0);
});

test('URL intake blocks unapproved, credentialed and private targets before fetch', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const neverFetch = async () => { throw new Error('should not fetch'); };
  await assert.rejects(() => intakeUrl({
    root, config, db, url: 'https://not-approved.test/', permittedScope: 'test', fetchImpl: neverFetch,
    resolveHost: async () => [{ address: '203.0.113.8', family: 4 }],
  }), /未列入/);
  await assert.rejects(() => intakeUrl({
    root, config, db, url: 'https://example.test/', permittedScope: 'test', fetchImpl: neverFetch,
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  }), /私有/);
});

test('supplied media transcript and keyframe keep stable time mappings without claiming ASR', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const media = join(root, 'training.mp4');
  const transcript = join(root, 'training.vtt');
  const keyframe = join(root, 'frame.png');
  await writeFile(media, Buffer.from('synthetic media bytes'));
  await writeFile(transcript, 'WEBVTT\n\n00:01:02.000 --> 00:01:05.250\n复核药名和否定词\n', 'utf8');
  await writeFile(keyframe, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const intake = await intakeFile({ root, config, db, file: media, sourceType: 'video' });
  const attached = await attachTranscript({ root, db, versionId: intake.versionId, file: transcript, kind: 'corrected', language: 'zh-CN' });
  const frame = await attachKeyframe({ root, db, versionId: intake.versionId, file: keyframe, timeMs: 63000, description: '虚构屏幕画面' });
  const hit = searchEvidence({ db, query: '否定词' })[0];
  assert.equal(attached.blockCount, 1);
  assert.equal(hit.versionId, intake.versionId);
  assert.equal(hit.locator.startMs, 62000);
  assert.equal(hit.locator.transcriptKind, 'corrected');
  assert.equal(frame.timeMs, 63000);
  assert.equal(JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(join(root, `derived/${intake.versionId}/supplied-corrected-transcript-${attached.sha256.slice(0, 12)}-v1.json`), 'utf8'))).metadata.asrPerformed, false);
});

test('usage ledger aggregates actual units and optional costs', async (t) => {
  const { db } = await fixture();
  t.after(() => db.close());
  recordUsage({ db, config, metric: 'llm_input_tokens', quantity: 120, provider: 'synthetic', costMinor: 2, currency: 'cny' });
  recordUsage({ db, config, metric: 'llm_input_tokens', quantity: 30, provider: 'synthetic', costMinor: 1, currency: 'cny' });
  const row = usageSummary({ db, config })[0];
  assert.equal(row.quantity, 150);
  assert.equal(row.costMinor, 3);
  assert.equal(row.currency, 'CNY');
});

test('controlled deletion requires exact confirmation, removes content and keeps an audit tombstone', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const intake = await intakeMessage({ root, config, db, messageId: 'delete-test', text: '待删除的合成证据内容' });
  await parseVersion({ root, db, versionId: intake.versionId });
  const hit = searchEvidence({ db, query: '合成证据' })[0];
  const claim = createClaim({ db, statement: '合成删除测试' });
  citeClaim({ db, claimId: claim.claimId, blockId: hit.blockId });
  const preview = await deletionImpact({ root, db, config, sourceId: intake.sourceId });
  assert.equal(preview.counts.citations, 1);
  await assert.rejects(() => deleteSource({ root, db, config, sourceId: intake.sourceId, confirmSourceId: 'wrong' }), /确认失败/);
  const deleted = await deleteSource({ root, db, config, sourceId: intake.sourceId, confirmSourceId: intake.sourceId });
  assert.equal(deleted.deleted, true);
  assert.equal(searchEvidence({ db, query: '合成证据' }).length, 0);
  await assert.rejects(() => stat(join(root, 'sources', intake.sourceId)));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM source_deletion').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_event WHERE event_type = 'source_deleted'").get().count, 1);
  assert.equal((await integrityReport({ root, db })).ok, true);
});
