import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertInside } from './project.mjs';
import { intakeFile } from './intake.mjs';

function isPrivateAddress(address) {
  if (address === '::1' || address === '::' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true;
  if (!address.includes('.')) return false;
  const parts = address.split('.').map(Number);
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    parts[0] >= 224;
}

function approved(config, url) {
  const allowed = config.network?.approvedServices || [];
  return allowed.some((entry) => {
    const value = String(entry).trim().toLowerCase();
    return value === url.hostname.toLowerCase() || value === url.origin.toLowerCase();
  });
}

async function validateTarget(config, value, resolveHost) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('网页抓取仅允许 HTTPS');
  if (url.username || url.password) throw new Error('网页 URL 不得包含凭据');
  if (!approved(config, url)) throw new Error(`目标未列入 network.approvedServices: ${url.hostname}`);
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await resolveHost(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`目标解析到私有、保留或不可验证地址: ${url.hostname}`);
  }
  return url;
}

function pageTitle(html, fallback) {
  const raw = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return raw || fallback;
}

export async function intakeUrl({
  root, config, db, url, permittedScope, title = null, sourceDomain = 'approved_web',
  confidentiality = null, documentDate = null, versionLabel = null,
  fetchImpl = fetch, resolveHost = lookup, maxBytes = 25 * 1024 * 1024,
}) {
  if (!permittedScope?.trim()) throw new Error('permitted-scope 必填，用于记录抓取许可范围');
  const requested = await validateTarget(config, url, resolveHost);
  let current = requested;
  let response;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetchImpl(current, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9' },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirects === 5) throw new Error('网页重定向次数超过 5');
    const location = response.headers.get('location');
    if (!location) throw new Error('重定向响应缺少 Location');
    current = await validateTarget(config, new URL(location, current).href, resolveHost);
  }
  if (!response?.ok) throw new Error(`网页抓取失败: HTTP ${response?.status ?? 'unknown'}`);
  const contentType = response.headers.get('content-type') || '';
  if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)) {
    throw new Error(`网页内容类型不受支持: ${contentType || '(missing)'}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`网页快照超过限制: ${bytes.byteLength} > ${maxBytes}`);
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const stagingDir = assertInside(root, join(root, 'runtime', 'web-intake'), 'web staging');
  await mkdir(stagingDir, { recursive: true });
  const staged = join(stagingDir, `${randomUUID()}.html`);
  await writeFile(staged, bytes, { flag: 'wx' });
  try {
    const intake = await intakeFile({
      root, config, db, file: staged, title: title || pageTitle(html, current.hostname), sourceType: 'url',
      sourceDomain, confidentiality: confidentiality || config.dataPolicy.defaultConfidentiality,
      originalReference: requested.href, documentDate, versionLabel,
    });
    const fetchedAt = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO source_snapshot
      (version_id, requested_url, final_url, fetched_at, content_type, permitted_scope, http_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(intake.versionId, requested.href, current.href, fetchedAt, contentType, permittedScope.trim(), response.status);
    return { ...intake, requestedUrl: requested.href, finalUrl: current.href, fetchedAt, contentType, permittedScope: permittedScope.trim() };
  } finally {
    await rm(staged, { force: true });
  }
}
