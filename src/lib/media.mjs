import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { assertInside } from './project.mjs';
import { hashFile, originalForVersion, persistParsedBlocks } from './evidence.mjs';
import { parseTranscriptJson, parseVtt } from './parsers.mjs';

const MEDIA_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.mp4', '.mov', '.mkv', '.webm']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function safeBase(name) {
  return basename(name).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_') || 'attachment.bin';
}

export async function attachTranscript({ root, db, versionId, file, kind = 'raw', language = null }) {
  if (!['raw', 'corrected'].includes(kind)) throw new Error(`无效 transcript-kind: ${kind}`);
  const source = originalForVersion(root, db, versionId);
  if (!MEDIA_EXTENSIONS.has(extname(source.file).toLowerCase()) && !['audio', 'video'].includes(source.source_type)) {
    throw new Error('转写只能挂接到音频或视频原件');
  }
  const extension = extname(file).toLowerCase();
  if (!['.vtt', '.json'].includes(extension)) throw new Error('转写仅支持 .vtt 或 .json');
  const digest = await hashFile(file);
  const existing = db.prepare(`SELECT attachment_id AS attachmentId, artifact_id AS artifactId,
    transcript_relative_path AS transcriptRelativePath FROM transcript_attachment
    WHERE media_version_id = ? AND transcript_kind = ? AND sha256 = ?`).get(versionId, kind, digest);
  if (existing) return { ...existing, versionId, kind, sha256: digest, duplicate: true };

  const attachmentId = `TRN-${randomUUID()}`;
  const targetDir = assertInside(root, join(root, 'derived', versionId, 'transcripts'), 'transcript target');
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, `${attachmentId}-${safeBase(file)}`);
  await copyFile(file, target);
  const text = await readFile(target, 'utf8');
  const parsed = extension === '.vtt' ? parseVtt(text) : parseTranscriptJson(text);
  const parsedBlocks = parsed.map((block) => ({
    ...block,
    locator: { ...block.locator, transcriptKind: kind, transcriptAttachmentId: attachmentId },
  }));
  const parserName = `supplied-${kind}-transcript-${digest.slice(0, 12)}`;
  const artifact = await persistParsedBlocks({
    root, db, source, parserName, parserVersion: '1', artifactKind: 'transcript', parsedBlocks,
    metadata: { asrPerformed: false, suppliedTranscript: true, transcriptKind: kind, language, transcriptSha256: digest },
  });
  const transcriptRelativePath = relative(root, target).replaceAll('\\', '/');
  db.prepare(`INSERT INTO transcript_attachment
    (attachment_id, media_version_id, artifact_id, transcript_kind, transcript_relative_path, sha256, language, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(attachmentId, versionId, artifact.artifactId, kind, transcriptRelativePath, digest, language, new Date().toISOString());
  return { attachmentId, artifactId: artifact.artifactId, versionId, kind, transcriptRelativePath, sha256: digest, blockCount: artifact.blockCount, duplicate: false };
}

export async function attachKeyframe({ root, db, versionId, file, timeMs, description = null }) {
  const source = originalForVersion(root, db, versionId);
  if (!['video'].includes(source.source_type) && !['.mp4', '.mov', '.mkv', '.webm'].includes(extname(source.file).toLowerCase())) {
    throw new Error('关键帧只能挂接到视频原件');
  }
  const numericTime = Number(timeMs);
  if (!Number.isInteger(numericTime) || numericTime < 0) throw new Error('time-ms 必须是非负整数');
  const extension = extname(file).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('关键帧仅支持 PNG/JPEG/WebP');
  const digest = await hashFile(file);
  const existing = db.prepare(`SELECT keyframe_id AS keyframeId, image_relative_path AS imageRelativePath
    FROM media_keyframe WHERE media_version_id = ? AND time_ms = ? AND sha256 = ?`).get(versionId, numericTime, digest);
  if (existing) return { ...existing, versionId, timeMs: numericTime, sha256: digest, duplicate: true };
  const keyframeId = `FRM-${randomUUID()}`;
  const targetDir = assertInside(root, join(root, 'derived', versionId, 'keyframes'), 'keyframe target');
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, `${keyframeId}${extension}`);
  await copyFile(file, target);
  const imageRelativePath = relative(root, target).replaceAll('\\', '/');
  db.prepare(`INSERT INTO media_keyframe
    (keyframe_id, media_version_id, time_ms, image_relative_path, sha256, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(keyframeId, versionId, numericTime, imageRelativePath, digest, description, new Date().toISOString());
  return { keyframeId, versionId, timeMs: numericTime, imageRelativePath, sha256: digest, description, duplicate: false };
}
