import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { hashFile, indexPlainText, originalForVersion, persistParsedBlocks, splitText } from './evidence.mjs';

function decodeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)));
}

function chunkValue(text, locatorFactory, maxChars = 1600) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const chunks = [];
  for (let offset = 0, part = 1; offset < normalized.length; offset += maxChars, part += 1) {
    chunks.push({ text: normalized.slice(offset, offset + maxChars), locator: locatorFactory(part) });
  }
  return chunks;
}

function timestampMs(value) {
  const match = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!match) throw new Error(`无效时间戳: ${value}`);
  return ((Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000) + Number(match[4]);
}

export function parseVtt(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const sections = normalized.split(/\n{2,}/);
  const blocks = [];
  for (const section of sections) {
    const lines = section.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines[0] === 'WEBVTT' || lines[0].startsWith('NOTE')) continue;
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [startRaw, endWithSettings] = lines[timingIndex].split('-->').map((part) => part.trim());
    const endRaw = endWithSettings.split(/\s+/)[0];
    const cueText = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!cueText) continue;
    blocks.push({
      text: cueText,
      locator: { kind: 'time', startMs: timestampMs(startRaw), endMs: timestampMs(endRaw) },
    });
  }
  return blocks;
}

export function parseTranscriptJson(text) {
  const value = JSON.parse(text);
  const entries = Array.isArray(value) ? value : value.segments;
  if (!Array.isArray(entries)) throw new Error('转录 JSON 必须是数组或包含 segments 数组');
  return entries.map((entry, index) => {
    const body = String(entry.text ?? '').trim();
    const startMs = Number(entry.startMs ?? (Number(entry.start) * 1000));
    const endMs = Number(entry.endMs ?? (Number(entry.end) * 1000));
    if (!body || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      throw new Error(`无效转录片段: ${index}`);
    }
    return {
      text: body,
      locator: {
        kind: 'time',
        startMs: Math.round(startMs),
        endMs: Math.round(endMs),
        ...(entry.speaker ? { speaker: String(entry.speaker) } : {}),
      },
    };
  });
}

async function verifiedSource(root, db, versionId) {
  const source = originalForVersion(root, db, versionId);
  const actualHash = await hashFile(source.file);
  if (actualHash !== source.sha256) throw new Error(`原件哈希不一致，拒绝解析: ${versionId}`);
  return source;
}

async function parsePdf({ root, db, source }) {
  const bytes = new Uint8Array(await readFile(source.file));
  const document = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
  const blocks = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str || '').join(' ');
    blocks.push(...chunkValue(text, (part) => ({ kind: 'page', page: pageNumber, part })));
  }
  return persistParsedBlocks({
    root, db, source, parserName: 'pdfjs-text', parserVersion: '1', parsedBlocks: blocks,
    metadata: { pages: document.numPages, ocrApplied: false },
  });
}

async function parseDocx({ root, db, source }) {
  const result = await mammoth.extractRawText({ path: source.file });
  const paragraphs = result.value.replace(/\r\n/g, '\n').split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  const blocks = paragraphs.map((text, index) => ({
    text,
    locator: { kind: 'paragraph', paragraph: index + 1 },
  }));
  return persistParsedBlocks({
    root, db, source, parserName: 'mammoth-docx', parserVersion: '1', parsedBlocks: blocks,
    metadata: { warnings: result.messages.map((message) => message.message) },
  });
}

async function parsePptx({ root, db, source }) {
  const zip = await JSZip.loadAsync(await readFile(source.file));
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  const blocks = [];
  for (const slideFile of slideFiles) {
    const slide = Number(slideFile.match(/slide(\d+)/)[1]);
    const xml = await zip.file(slideFile).async('string');
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1])).join(' ');
    blocks.push(...chunkValue(text, (part) => ({ kind: 'slide', slide, part, contentType: 'body' })));
    const notesFile = `ppt/notesSlides/notesSlide${slide}.xml`;
    if (zip.file(notesFile)) {
      const notesXml = await zip.file(notesFile).async('string');
      const notes = [...notesXml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1])).join(' ');
      blocks.push(...chunkValue(notes, (part) => ({ kind: 'slide', slide, part, contentType: 'notes' })));
    }
  }
  return persistParsedBlocks({
    root, db, source, parserName: 'pptx-xml', parserVersion: '1', parsedBlocks: blocks,
    metadata: { slides: slideFiles.length },
  });
}

async function parseHtml({ root, db, source }) {
  const html = await readFile(source.file, 'utf8');
  const safe = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  const text = decodeXml(safe);
  return persistParsedBlocks({
    root, db, source, parserName: 'html-static-text', parserVersion: '1', parsedBlocks: splitText(text),
    metadata: { scriptsExecuted: false },
  });
}

async function parseTranscript({ root, db, source, extension }) {
  const text = await readFile(source.file, 'utf8');
  const blocks = extension === '.vtt' ? parseVtt(text) : parseTranscriptJson(text);
  return persistParsedBlocks({
    root, db, source, parserName: extension === '.vtt' ? 'webvtt' : 'transcript-json',
    parserVersion: '1', artifactKind: 'transcript', parsedBlocks: blocks,
    metadata: { asrPerformed: false, suppliedTranscript: true },
  });
}

export async function parseVersion({ root, db, versionId }) {
  const source = await verifiedSource(root, db, versionId);
  const extension = extname(basename(source.file)).toLowerCase();
  try {
    if (['.txt', '.md', '.markdown'].includes(extension)) return await indexPlainText({ root, db, versionId });
    if (extension === '.pdf') return await parsePdf({ root, db, source });
    if (extension === '.docx') return await parseDocx({ root, db, source });
    if (extension === '.pptx') return await parsePptx({ root, db, source });
    if (['.html', '.htm'].includes(extension)) return await parseHtml({ root, db, source });
    if (extension === '.vtt') return await parseTranscript({ root, db, source, extension });
    if (extension === '.json' && source.source_type === 'transcript') return await parseTranscript({ root, db, source, extension });
    throw new Error(`尚未验证的格式: ${extension || '(无扩展名)'}`);
  } catch (error) {
    db.prepare("UPDATE source_version SET processing_status = 'failed' WHERE version_id = ?").run(versionId);
    throw error;
  }
}
