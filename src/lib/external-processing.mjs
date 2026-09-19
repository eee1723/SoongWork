import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { hashFile, originalForVersion, persistParsedBlocks } from './evidence.mjs';
import { recordUsage } from './operations.mjs';
import { assertInside } from './project.mjs';

const API_ORIGIN = 'https://api.siliconflow.cn';
const OCR_EXTENSIONS = new Map([
  ['.pdf', 'application/pdf'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.gif', 'image/gif'],
]);
const AUDIO_EXTENSIONS = new Map([
  ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.m4a', 'audio/mp4'], ['.mp4', 'audio/mp4'],
  ['.flac', 'audio/flac'], ['.ogg', 'audio/ogg'], ['.opus', 'audio/ogg'], ['.webm', 'audio/webm'],
]);
const OCR_MAX_BYTES = 25 * 1024 * 1024;
const ASR_MAX_BYTES = 50 * 1024 * 1024;
const MAX_RESPONSE_TEXT = 2 * 1024 * 1024;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function redactSecrets(value) {
  return String(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
}

async function apiKey(env, root) {
  const direct = env.SILICONFLOW_API_KEY?.trim();
  if (direct) return direct;
  const configuredFile = env.SILICONFLOW_CREDENTIAL_FILE?.trim();
  if (!configuredFile) {
    throw new Error('缺少 SILICONFLOW_API_KEY 或 SILICONFLOW_CREDENTIAL_FILE；请在本机安全配置，不要写入项目文件');
  }
  if (!isAbsolute(configuredFile)) throw new Error('SILICONFLOW_CREDENTIAL_FILE 必须是绝对路径');
  const file = resolve(configuredFile);
  const rel = relative(resolve(root), file);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('凭据文件必须位于项目目录之外');
  const fileStat = await stat(file);
  if (!fileStat.isFile() || fileStat.size > 4096) throw new Error('SiliconFlow 凭据文件无效或超过 4 KiB');
  const value = (await readFile(file, 'utf8')).trim();
  if (!value) throw new Error('SiliconFlow 凭据文件为空');
  return value;
}

function assertExternalAllowed(config, source, env) {
  if (!config.dataPolicy?.externalTransmissionAllowed) {
    throw new Error('项目配置 externalTransmissionAllowed=false，拒绝向外部 OCR/ASR 服务发送原件');
  }
  if (env.PET_LEARNING_ALLOW_EXTERNAL_PROCESSING !== '1') {
    throw new Error('缺少 PET_LEARNING_ALLOW_EXTERNAL_PROCESSING=1，本次外部处理未显式启用');
  }
  if (source.confidentiality === 'internal' && !config.dataPolicy?.realCompanyDataApproved) {
    throw new Error('内部资料尚未批准，拒绝发送到外部 OCR/ASR 服务');
  }
  const approved = config.network?.approvedServices || [];
  if (!approved.some((entry) => {
    try { return new URL(entry).origin === API_ORIGIN; } catch { return entry === 'api.siliconflow.cn'; }
  })) throw new Error(`network.approvedServices 未批准 ${API_ORIGIN}`);
}

function chunks(text, locator, maxChars = 4000) {
  const value = text.trim();
  if (!value) throw new Error('外部服务返回了空文本');
  if (value.length > MAX_RESPONSE_TEXT) throw new Error('外部服务返回文本超过 2 MiB 安全上限');
  const output = [];
  for (let offset = 0, part = 1; offset < value.length; offset += maxChars, part += 1) {
    output.push({ text: value.slice(offset, offset + maxChars), locator: { ...locator, part } });
  }
  return output;
}

function safeModel(value, fallback) {
  const model = (value || fallback).trim();
  if (!/^[A-Za-z0-9._/-]{1,160}$/.test(model)) throw new Error(`无效模型名称: ${model}`);
  return model;
}

function parserVersion(model) {
  return `1-${sha256(model).slice(0, 12)}`;
}

function startRun(db, { versionId, capability, model, requestSha256 }) {
  const previous = db.prepare(`SELECT run_id AS runId, artifact_id AS artifactId, provider_trace_id AS providerTraceId
    FROM external_processing_run WHERE request_sha256 = ? AND status = 'succeeded'
    ORDER BY completed_at DESC LIMIT 1`).get(requestSha256);
  if (previous) return { duplicate: true, ...previous };
  const runId = `XPR-${randomUUID()}`;
  db.prepare(`INSERT INTO external_processing_run
    (run_id, version_id, capability, provider, model, status, request_sha256, created_at)
    VALUES (?, ?, ?, 'siliconflow', ?, 'running', ?, ?)`)
    .run(runId, versionId, capability, model, requestSha256, new Date().toISOString());
  return { duplicate: false, runId };
}

function finishRun(db, runId, { status, artifactId = null, traceId = null, metadata = null, error = null }) {
  const completedAt = new Date().toISOString();
  db.prepare(`UPDATE external_processing_run SET status = ?, artifact_id = ?, provider_trace_id = ?,
    response_meta_json = ?, error_message = ?, completed_at = ? WHERE run_id = ?`)
    .run(status, artifactId, traceId, metadata ? JSON.stringify(metadata) : null,
      error ? redactSecrets(error).slice(0, 2000) : null, completedAt, runId);
  db.prepare(`INSERT INTO audit_event
    (event_id, occurred_at, event_type, object_type, object_id, actor, detail_json)
    VALUES (?, ?, ?, 'external_processing_run', ?, 'local-cli', ?)`)
    .run(`EVT-${randomUUID()}`, completedAt, status === 'succeeded' ? 'external_processing_succeeded' : 'external_processing_failed',
      runId, JSON.stringify({ artifactId, traceId, status }));
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry(url, options, { fetchImpl = fetch, retries = 3, sleep = wait } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(180_000) });
      if (response.ok) return response;
      const body = redactSecrets((await response.text()).slice(0, 2000));
      lastError = new Error(`SiliconFlow HTTP ${response.status}: ${body}`);
      if (![429, 503, 504].includes(response.status) || attempt === retries) throw lastError;
      const retryAfter = Math.min(Number(response.headers.get('retry-after')) || attempt, 10);
      await sleep(retryAfter * 1000);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)) throw error;
      await sleep(attempt * 500);
    }
  }
  throw lastError;
}

async function verifiedSource(root, db, versionId) {
  const source = originalForVersion(root, db, versionId);
  if (await hashFile(source.file) !== source.sha256) throw new Error(`原件哈希不一致，拒绝外部处理: ${versionId}`);
  return source;
}

function recordTokenUsage(db, config, source, usage, model) {
  if (Number.isFinite(usage?.prompt_tokens)) recordUsage({
    db, config, metric: 'llm_input_tokens', quantity: usage.prompt_tokens, provider: 'siliconflow',
    sourceVersionId: source.version_id, note: `OCR ${model}`,
  });
  if (Number.isFinite(usage?.completion_tokens)) recordUsage({
    db, config, metric: 'llm_output_tokens', quantity: usage.completion_tokens, provider: 'siliconflow',
    sourceVersionId: source.version_id, note: `OCR ${model}`,
  });
}

function chatText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n');
  throw new Error('SiliconFlow OCR 响应缺少 choices[0].message.content');
}

async function ocrPptxImages({ root, db, config, source, env, fetchImpl, retries, model }) {
  const rows = db.prepare(`SELECT derived_file_id AS derivedFileId, relative_path AS relativePath,
    sha256, locator_json AS locatorJson FROM derived_file
    WHERE version_id = ? AND file_kind = 'pptx-embedded-image' ORDER BY relative_path`).all(source.version_id);
  if (!rows.length) throw new Error('PPTX 尚无可 OCR 的内嵌图片；请先运行 parse --version-id');
  if (rows.length > 200) throw new Error('PPTX 内嵌图片超过 200 张安全上限，请拆分文件后处理');
  const files = [];
  let totalBytes = 0;
  for (const row of rows) {
    const file = assertInside(root, resolve(root, row.relativePath), 'PPTX derived image');
    const extension = extname(file).toLowerCase();
    const mime = OCR_EXTENSIONS.get(extension);
    if (!mime) continue;
    const fileStat = await stat(file);
    if (fileStat.size > OCR_MAX_BYTES) throw new Error(`PPTX 图片超过 25 MiB 安全上限: ${row.relativePath}`);
    totalBytes += fileStat.size;
    if (totalBytes > 100 * 1024 * 1024) throw new Error('PPTX 待 OCR 图片总量超过 100 MiB 安全上限');
    if (await hashFile(file) !== row.sha256) throw new Error(`PPTX 派生图片哈希不一致: ${row.relativePath}`);
    files.push({ ...row, file, mime, locator: JSON.parse(row.locatorJson) });
  }
  if (!files.length) throw new Error('PPTX 没有 SiliconFlow OCR 支持的内嵌图片格式');
  const prompt = '<image>\n<|grounding|>OCR this image. Preserve headings, tables, numbers and units. Do not infer missing text.';
  const requestSha256 = sha256(`${source.sha256}:pptx-image-ocr:${model}:${prompt}:${files.map((item) => item.sha256).join(':')}`);
  const run = startRun(db, { versionId: source.version_id, capability: 'ocr', model, requestSha256 });
  if (run.duplicate) return { ...run, versionId: source.version_id, capability: 'ocr', model };
  try {
    const blocks = [];
    const traceIds = [];
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    for (const [index, item] of files.entries()) {
      const bytes = await readFile(item.file);
      const response = await requestWithRetry(`${API_ORIGIN}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await apiKey(env, root)}`, 'content-type': 'application/json', 'x-trace-id': `${run.runId}-${index + 1}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${item.mime};base64,${bytes.toString('base64')}`, detail: 'high' } },
            { type: 'text', text: prompt },
          ] }],
          max_tokens: 8192,
          stream: false,
        }),
      }, { fetchImpl, retries });
      const payload = await response.json();
      const traceId = response.headers.get('x-siliconcloud-trace-id') || response.headers.get('x-trace-id') || `${run.runId}-${index + 1}`;
      traceIds.push(traceId);
      usage.prompt_tokens += Number(payload.usage?.prompt_tokens) || 0;
      usage.completion_tokens += Number(payload.usage?.completion_tokens) || 0;
      blocks.push(...chunks(chatText(payload), {
        kind: 'slide_image_ocr', slides: item.locator.slides || [], image: basename(item.relativePath),
        derivedFileId: item.derivedFileId,
      }));
    }
    const parsed = await persistParsedBlocks({
      root, db, source, parserName: 'siliconflow-pptx-image-ocr', parserVersion: parserVersion(model), artifactKind: 'ocr_text',
      parsedBlocks: blocks,
      metadata: { provider: 'siliconflow', model, externalProcessing: true, traceIds, images: files.length },
    });
    finishRun(db, run.runId, { status: 'succeeded', artifactId: parsed.artifactId, traceId: traceIds[0] || run.runId,
      metadata: { traceIds, images: files.length, usage } });
    recordTokenUsage(db, config, source, usage, model);
    return { ...parsed, runId: run.runId, capability: 'ocr', model, traceIds, imageCount: files.length, locatorPrecision: 'slide-image' };
  } catch (error) {
    finishRun(db, run.runId, { status: 'failed', error: error.message });
    throw error;
  }
}

export async function runSiliconFlowOcr({ root, db, config, versionId, env = process.env, fetchImpl = fetch, retries = 3 }) {
  const source = await verifiedSource(root, db, versionId);
  assertExternalAllowed(config, source, env);
  const extension = extname(source.file).toLowerCase();
  const model = safeModel(env.SILICONFLOW_OCR_MODEL, 'deepseek-ai/DeepSeek-OCR');
  if (extension === '.pptx') {
    return ocrPptxImages({ root, db, config, source, env, fetchImpl, retries, model });
  }
  const mime = OCR_EXTENSIONS.get(extension);
  if (!mime) throw new Error(`OCR 不支持的原件格式: ${extension || '(无扩展名)'}`);
  const fileStat = await stat(source.file);
  if (fileStat.size > OCR_MAX_BYTES) throw new Error('OCR 原件超过 25 MiB 安全上限');
  const prompt = extension === '.pdf'
    ? '<image>\n<|grounding|>Convert the document to markdown.'
    : '<image>\n<|grounding|>OCR this image. Preserve headings, tables, numbers and units. Do not infer missing text.';
  const requestSha256 = sha256(`${source.sha256}:ocr:${model}:${prompt}`);
  const run = startRun(db, { versionId, capability: 'ocr', model, requestSha256 });
  if (run.duplicate) return { ...run, versionId, capability: 'ocr', model };
  try {
    const bytes = await readFile(source.file);
    const response = await requestWithRetry(`${API_ORIGIN}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await apiKey(env, root)}`, 'content-type': 'application/json', 'x-trace-id': run.runId },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}`, detail: 'high' } },
          { type: 'text', text: prompt },
        ] }],
        max_tokens: 8192,
        stream: false,
      }),
    }, { fetchImpl, retries });
    const payload = await response.json();
    const traceId = response.headers.get('x-siliconcloud-trace-id') || response.headers.get('x-trace-id') || run.runId;
    const parsed = await persistParsedBlocks({
      root, db, source, parserName: 'siliconflow-ocr', parserVersion: parserVersion(model), artifactKind: 'ocr_text',
      parsedBlocks: chunks(chatText(payload), extension === '.pdf'
        ? { kind: 'document_ocr', pageMapping: 'not-provided' }
        : { kind: 'image_ocr', image: 1 }),
      metadata: { provider: 'siliconflow', model, externalProcessing: true, traceId, pageMapping: 'not-provided' },
    });
    finishRun(db, run.runId, { status: 'succeeded', artifactId: parsed.artifactId, traceId,
      metadata: { usage: payload.usage || null, finishReason: payload.choices?.[0]?.finish_reason || null } });
    recordTokenUsage(db, config, source, payload.usage, model);
    return { ...parsed, runId: run.runId, capability: 'ocr', model, traceId, locatorPrecision: extension === '.pdf' ? 'document' : 'image' };
  } catch (error) {
    finishRun(db, run.runId, { status: 'failed', error: error.message });
    throw error;
  }
}

export async function runSiliconFlowAsr({ root, db, config, versionId, env = process.env, fetchImpl = fetch, retries = 3 }) {
  const source = await verifiedSource(root, db, versionId);
  assertExternalAllowed(config, source, env);
  const extension = extname(source.file).toLowerCase();
  const mime = AUDIO_EXTENSIONS.get(extension);
  if (!mime) throw new Error(`ASR 不支持的原件格式: ${extension || '(无扩展名)'}`);
  const fileStat = await stat(source.file);
  if (fileStat.size > ASR_MAX_BYTES) throw new Error('音频超过 SiliconFlow 50MB 单文件上限；请先在本地切分');
  const model = safeModel(env.SILICONFLOW_ASR_MODEL, 'FunAudioLLM/SenseVoiceSmall');
  const requestSha256 = sha256(`${source.sha256}:asr:${model}`);
  const run = startRun(db, { versionId, capability: 'asr', model, requestSha256 });
  if (run.duplicate) return { ...run, versionId, capability: 'asr', model };
  try {
    const bytes = await readFile(source.file);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), basename(source.file));
    form.append('model', model);
    const response = await requestWithRetry(`${API_ORIGIN}/v1/audio/transcriptions`, {
      method: 'POST', headers: { authorization: `Bearer ${await apiKey(env, root)}`, 'x-trace-id': run.runId }, body: form,
    }, { fetchImpl, retries });
    const payload = await response.json();
    if (typeof payload?.text !== 'string') throw new Error('SiliconFlow ASR 响应缺少 text');
    const traceId = response.headers.get('x-siliconcloud-trace-id') || response.headers.get('x-trace-id') || run.runId;
    const parsed = await persistParsedBlocks({
      root, db, source, parserName: 'siliconflow-asr', parserVersion: parserVersion(model), artifactKind: 'transcript',
      parsedBlocks: chunks(payload.text, { kind: 'media_transcript', timing: 'not-provided' }),
      metadata: { provider: 'siliconflow', model, externalProcessing: true, traceId, timestampsProvided: false },
    });
    finishRun(db, run.runId, { status: 'succeeded', artifactId: parsed.artifactId, traceId,
      metadata: { timestampsProvided: false } });
    return { ...parsed, runId: run.runId, capability: 'asr', model, traceId, locatorPrecision: 'whole-media' };
  } catch (error) {
    finishRun(db, run.runId, { status: 'failed', error: error.message });
    throw error;
  }
}

export function listExternalProcessingRuns(db, versionId = null) {
  const rows = versionId
    ? db.prepare(`SELECT * FROM external_processing_run WHERE version_id = ? ORDER BY created_at DESC`).all(versionId)
    : db.prepare(`SELECT * FROM external_processing_run ORDER BY created_at DESC LIMIT 200`).all();
  return rows.map((row) => ({
    runId: row.run_id, versionId: row.version_id, capability: row.capability, provider: row.provider,
    model: row.model, status: row.status, artifactId: row.artifact_id, providerTraceId: row.provider_trace_id,
    responseMeta: row.response_meta_json ? JSON.parse(row.response_meta_json) : null,
    errorMessage: row.error_message, createdAt: row.created_at, completedAt: row.completed_at,
  }));
}
