import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { intakeFile } from './intake.mjs';
import { parseVersion } from './parsers.mjs';
import { runSiliconFlowAsr, runSiliconFlowOcr } from './external-processing.mjs';
import { atomicWriteJson, assertInside } from './project.mjs';

const LOCAL_PARSE = new Set(['.txt', '.md', '.markdown', '.pdf', '.docx', '.pptx', '.xlsx', '.html', '.htm', '.vtt']);
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus']);
const VIDEO_AUDIO = new Set(['.mp4', '.webm']);
const SUPPORTED = new Set([...LOCAL_PARSE, ...IMAGES, ...AUDIO, ...VIDEO_AUDIO]);
const GENERATED_ROOTS = new Set(['sources', 'derived', 'runtime', 'exports', 'node_modules', '.git']);

function sourceType(extension) {
  if (IMAGES.has(extension)) return 'image';
  if (AUDIO.has(extension)) return 'audio';
  if (VIDEO_AUDIO.has(extension)) return 'video';
  if (extension === '.pptx') return 'presentation';
  if (extension === '.xlsx') return 'spreadsheet';
  if (extension === '.vtt') return 'transcript';
  return 'document';
}

function titleFor(file) {
  const name = basename(file);
  return name.slice(0, Math.max(1, name.length - extname(name).length));
}

async function discover(directory, recursive, current = directory) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && recursive) files.push(...await discover(directory, recursive, file));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`布尔参数必须是 true 或 false: ${value}`);
}

export async function importDirectory({
  root, db, config, sourceDir, recursive = true, externalMedia = false,
  confidentiality = null, sourceDomain = 'bulk_import', env = process.env,
}) {
  if (!sourceDir) throw new Error('sourceDir 必填');
  const directory = await realpath(resolve(sourceDir));
  if (!(await stat(directory)).isDirectory()) throw new Error(`不是目录: ${directory}`);
  const relToProject = relative(resolve(root), directory);
  if (relToProject && !relToProject.startsWith('..')) {
    const first = relToProject.split(/[\\/]/)[0];
    if (GENERATED_ROOTS.has(first)) throw new Error(`拒绝从项目生成目录批量导入: ${first}`);
  }
  const includeNested = toBoolean(recursive, true);
  const useExternal = toBoolean(externalMedia, false);
  const files = await discover(directory, includeNested);
  const startedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    importRunId: `BIM-${randomUUID()}`,
    sourceDirectory: directory,
    recursive: includeNested,
    externalMedia: useExternal,
    startedAt,
    completedAt: null,
    totals: { discovered: files.length, supported: 0, received: 0, indexed: 0, storedOnly: 0, skipped: 0, failed: 0 },
    files: [],
  };

  for (const file of files) {
    const extension = extname(file).toLowerCase();
    const displayPath = relative(directory, file).replaceAll('\\', '/');
    if (!SUPPORTED.has(extension)) {
      report.files.push({ file: displayPath, extension, status: 'skipped', reason: 'unsupported-extension' });
      report.totals.skipped += 1;
      continue;
    }
    report.totals.supported += 1;
    try {
      const intake = await intakeFile({
        root, config, db, file, title: titleFor(file), sourceType: sourceType(extension), sourceDomain,
        confidentiality: confidentiality || config.dataPolicy.defaultConfidentiality,
        originalReference: file,
      });
      report.totals.received += 1;
      const item = {
        file: displayPath, extension, sourceId: intake.sourceId, versionId: intake.versionId,
        duplicateContent: intake.duplicateContent,
      };

      if (LOCAL_PARSE.has(extension)) {
        try {
          const parsed = await parseVersion({ root, db, versionId: intake.versionId });
          item.localParse = parsed;
          item.status = 'indexed-local';
          report.totals.indexed += 1;
        } catch (error) {
          item.localParseError = error.message;
          if (extension === '.pdf' && useExternal) {
            item.externalProcessing = await runSiliconFlowOcr({ root, db, config, versionId: intake.versionId, env });
            item.status = 'indexed-ocr-fallback';
            report.totals.indexed += 1;
          } else {
            throw error;
          }
        }
        if (extension === '.pptx' && useExternal && Number(item.localParse?.imageCount || 0) > 0) {
          try {
            item.externalProcessing = await runSiliconFlowOcr({ root, db, config, versionId: intake.versionId, env });
            item.status = 'indexed-local-and-image-ocr';
          } catch (error) {
            item.externalProcessingError = error.message;
            item.status = 'indexed-local-external-failed';
            report.totals.failed += 1;
          }
        }
      } else if (IMAGES.has(extension) && useExternal) {
        item.externalProcessing = await runSiliconFlowOcr({ root, db, config, versionId: intake.versionId, env });
        item.status = 'indexed-ocr';
        report.totals.indexed += 1;
      } else if ((AUDIO.has(extension) || VIDEO_AUDIO.has(extension)) && useExternal) {
        item.externalProcessing = await runSiliconFlowAsr({ root, db, config, versionId: intake.versionId, env });
        item.status = 'indexed-transcript';
        report.totals.indexed += 1;
      } else {
        item.status = 'stored-only';
        item.reason = IMAGES.has(extension) ? 'external-ocr-not-enabled' : 'external-asr-not-enabled';
        report.totals.storedOnly += 1;
      }
      report.files.push(item);
    } catch (error) {
      report.files.push({ file: displayPath, extension, status: 'failed', error: error.message });
      report.totals.failed += 1;
    }
  }

  report.completedAt = new Date().toISOString();
  report.ok = report.totals.failed === 0;
  const reportRelativePath = `runtime/import-runs/${report.importRunId}.json`;
  await atomicWriteJson(assertInside(root, join(root, reportRelativePath), 'bulk import report'), report);
  return { ...report, reportRelativePath };
}
