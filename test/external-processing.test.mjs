import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ensureProjectDirs } from '../src/lib/project.mjs';
import { openCatalog } from '../src/lib/catalog.mjs';
import { intakeFile } from '../src/lib/intake.mjs';
import { searchEvidence } from '../src/lib/evidence.mjs';
import { listExternalProcessingRuns, runSiliconFlowAsr, runSiliconFlowOcr } from '../src/lib/external-processing.mjs';

const allowedConfig = {
  schemaVersion: 6,
  projectId: 'external-processing-test',
  dataPolicy: { defaultConfidentiality: 'internal', externalTransmissionAllowed: true, realCompanyDataApproved: true },
  network: { mode: 'deny-by-default', approvedServices: ['https://api.siliconflow.cn'] },
};
const env = { SILICONFLOW_API_KEY: 'unit-test-secret', PET_LEARNING_ALLOW_EXTERNAL_PROCESSING: '1' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pet-external-'));
  await ensureProjectDirs(root);
  return { root, db: openCatalog(root, allowedConfig) };
}

test('SiliconFlow OCR is gated, indexed, auditable and idempotent without storing its key', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const image = join(root, 'synthetic.jpg');
  await writeFile(image, Buffer.from('not-a-real-image'));
  const credentialFile = join(dirname(root), `${basename(root)}.siliconflow.key`);
  await writeFile(credentialFile, 'unit-test-secret', 'utf8');
  t.after(() => rm(credentialFile, { force: true }));
  const fileEnv = { SILICONFLOW_CREDENTIAL_FILE: credentialFile, PET_LEARNING_ALLOW_EXTERNAL_PROCESSING: '1' };
  const intake = await intakeFile({ root, config: allowedConfig, db, file: image, title: '合成图片', sourceType: 'image' });

  await assert.rejects(() => runSiliconFlowOcr({
    root, db, config: { ...allowedConfig, dataPolicy: { ...allowedConfig.dataPolicy, externalTransmissionAllowed: false } },
    versionId: intake.versionId, env,
  }), /externalTransmissionAllowed=false/);

  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.siliconflow.cn/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer unit-test-secret');
    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '合成 OCR 文本：样本编号 001' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    }), { status: 200, headers: { 'x-siliconcloud-trace-id': 'trace-ocr-1' } });
  };
  const result = await runSiliconFlowOcr({ root, db, config: allowedConfig, versionId: intake.versionId, env: fileEnv, fetchImpl, retries: 1 });
  assert.equal(result.locatorPrecision, 'image');
  assert.equal(searchEvidence({ db, query: '样本编号' })[0].locator.kind, 'image_ocr');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get().count, 2);
  const duplicate = await runSiliconFlowOcr({ root, db, config: allowedConfig, versionId: intake.versionId, env: fileEnv, fetchImpl, retries: 1 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(listExternalProcessingRuns(db)), /unit-test-secret/);
});

test('SiliconFlow ASR creates a whole-media transcript and never invents timestamps', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const audio = join(root, 'synthetic.wav');
  await writeFile(audio, Buffer.from('RIFF-synthetic-audio'));
  const intake = await intakeFile({ root, config: allowedConfig, db, file: audio, title: '合成录音', sourceType: 'audio' });
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.siliconflow.cn/v1/audio/transcriptions');
    assert.equal(options.body instanceof FormData, true);
    assert.equal(options.body.get('model'), 'FunAudioLLM/SenseVoiceSmall');
    return new Response(JSON.stringify({ text: '这是一段不带时间戳的合成转录。' }), {
      status: 200, headers: { 'x-siliconcloud-trace-id': 'trace-asr-1' },
    });
  };
  const result = await runSiliconFlowAsr({ root, db, config: allowedConfig, versionId: intake.versionId, env, fetchImpl, retries: 1 });
  assert.equal(result.locatorPrecision, 'whole-media');
  const found = searchEvidence({ db, query: '合成转录' })[0];
  assert.deepEqual(found.locator, { kind: 'media_transcript', timing: 'not-provided', part: 1 });
  assert.equal(listExternalProcessingRuns(db, intake.versionId)[0].status, 'succeeded');
});

test('failed external processing is recorded without claiming an artifact', async (t) => {
  const { root, db } = await fixture();
  t.after(() => db.close());
  const image = join(root, 'failure.png');
  await writeFile(image, Buffer.from('synthetic'));
  const intake = await intakeFile({ root, config: allowedConfig, db, file: image, sourceType: 'image' });
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 });
  await assert.rejects(() => runSiliconFlowOcr({
    root, db, config: allowedConfig, versionId: intake.versionId, env, fetchImpl, retries: 1,
  }), /HTTP 429/);
  const run = listExternalProcessingRuns(db)[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.artifactId, null);
});
