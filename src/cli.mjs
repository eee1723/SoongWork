#!/usr/bin/env node
import { resolve } from 'node:path';
import { ensureProjectDirs, loadConfig, projectRoot } from './lib/project.mjs';
import { openCatalog } from './lib/catalog.mjs';
import { intakeFile, intakeMessage } from './lib/intake.mjs';
import { intakeUrl } from './lib/web-intake.mjs';
import { runP0 } from './lib/p0.mjs';
import { citeClaim, createClaim, indexPlainText, searchEvidence, verifyCitations } from './lib/evidence.mjs';
import { parseVersion } from './lib/parsers.mjs';
import {
  addConcept, addLearningLog, addMemory, addWorkLog, createConflict, enqueueParse, listMemories,
  relateConcepts, resolveConflict, reviewMemory, runJobs,
} from './lib/state.mjs';
import { createBackup, exportCatalog, integrityReport, restoreBackup } from './lib/maintenance.mjs';
import { attachKeyframe, attachTranscript } from './lib/media.mjs';
import { deleteSource, deletionImpact, recordUsage, usageSummary } from './lib/operations.mjs';

function parseArgs(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`无法识别的参数: ${token}`);
    const key = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值`);
    options[key] = value;
    i += 1;
  }
  return { command, options };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const root = projectRoot(process.env.PET_LEARNING_ROOT || process.cwd());
  const { command, options } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(root);
  await ensureProjectDirs(root);

  if (command === 'init') {
    const db = openCatalog(root, config);
    db.close();
    print({ ok: true, projectId: config.projectId, root, schemaVersion: config.schemaVersion });
    return;
  }

  if (command === 'check') {
    const db = openCatalog(root, config);
    db.close();
    print(await runP0({ root, config }));
    return;
  }

  const db = openCatalog(root, config);
  try {
    if (command === 'intake-file') {
      if (!options.file) throw new Error('--file 必填');
      print(await intakeFile({
        root, config, db, file: resolve(options.file), title: options.title,
        sourceType: options['source-type'], sourceDomain: options['source-domain'],
        confidentiality: options.confidentiality, documentDate: options['document-date'],
        versionLabel: options['version-label'], sourceId: options['source-id'],
        supersedesVersionId: options['supersedes-version-id'], originalReference: options['original-reference'],
      }));
      return;
    }
    if (command === 'intake-message') {
      print(await intakeMessage({
        root, config, db, text: options.text, messageId: options['message-id'], title: options.title,
        sourceDomain: options['source-domain'], confidentiality: options.confidentiality,
        documentDate: options['document-date'], versionLabel: options['version-label'],
        sourceId: options['source-id'], supersedesVersionId: options['supersedes-version-id'],
      }));
      return;
    }
    if (command === 'intake-url') {
      if (!options.url || !options['permitted-scope']) throw new Error('--url 和 --permitted-scope 必填');
      const intake = await intakeUrl({
        root, config, db, url: options.url, permittedScope: options['permitted-scope'], title: options.title,
        sourceDomain: options['source-domain'], confidentiality: options.confidentiality,
        documentDate: options['document-date'], versionLabel: options['version-label'],
      });
      const parsed = await parseVersion({ root, db, versionId: intake.versionId });
      print({ ...intake, parsed });
      return;
    }
    if (command === 'list-sources') {
      const rows = db.prepare(`SELECT s.source_id AS sourceId, s.title, s.source_type AS sourceType,
        v.version_id AS versionId, v.received_at AS receivedAt, v.processing_status AS processingStatus,
        v.review_status AS reviewStatus, v.validity_status AS validityStatus, v.original_relative_path AS originalRelativePath
        FROM source s JOIN source_version v ON v.source_id = s.source_id ORDER BY v.received_at DESC`).all();
      print(rows);
      return;
    }
    if (command === 'index-text') {
      if (!options['version-id']) throw new Error('--version-id 必填');
      print(await indexPlainText({ root, db, versionId: options['version-id'] }));
      return;
    }
    if (command === 'parse') {
      if (!options['version-id']) throw new Error('--version-id 必填');
      print(await parseVersion({ root, db, versionId: options['version-id'] }));
      return;
    }
    if (command === 'attach-transcript') {
      if (!options['version-id'] || !options.file) throw new Error('--version-id 和 --file 必填');
      print(await attachTranscript({
        root, db, versionId: options['version-id'], file: resolve(options.file),
        kind: options.kind || 'raw', language: options.language,
      }));
      return;
    }
    if (command === 'attach-keyframe') {
      if (!options['version-id'] || !options.file || options['time-ms'] === undefined) {
        throw new Error('--version-id、--file 和 --time-ms 必填');
      }
      print(await attachKeyframe({
        root, db, versionId: options['version-id'], file: resolve(options.file),
        timeMs: options['time-ms'], description: options.description,
      }));
      return;
    }
    if (command === 'search') {
      if (!options.query) throw new Error('--query 必填');
      print(searchEvidence({ db, query: options.query, limit: options.limit }));
      return;
    }
    if (command === 'create-claim') {
      if (!options.statement) throw new Error('--statement 必填');
      print(createClaim({ db, statement: options.statement, risk: options.risk }));
      return;
    }
    if (command === 'cite-claim') {
      if (!options['claim-id'] || !options['block-id']) throw new Error('--claim-id 和 --block-id 必填');
      print(citeClaim({ db, claimId: options['claim-id'], blockId: options['block-id'], role: options.role }));
      return;
    }
    if (command === 'verify-citations') {
      print(await verifyCitations({ root, db, citationId: options['citation-id'] || null }));
      return;
    }
    if (command === 'create-conflict') {
      print(createConflict({ db, title: options.title, versionIds: (options.versions || '').split(',').filter(Boolean) }));
      return;
    }
    if (command === 'resolve-conflict') {
      print(resolveConflict({ db, conflictGroupId: options['conflict-id'], resolution: options.resolution }));
      return;
    }
    if (command === 'add-concept') {
      print(addConcept({ db, name: options.name, description: options.description,
        aliases: (options.aliases || '').split(',').filter(Boolean) }));
      return;
    }
    if (command === 'relate-concepts') {
      print(relateConcepts({ db, fromConceptId: options.from, toConceptId: options.to,
        type: options.type, citationId: options['citation-id'] }));
      return;
    }
    if (command === 'add-memory') {
      print(addMemory({ db, config, category: options.category, content: options.content,
        sourceMessageId: options['message-id'], sourceVersionId: options['version-id'],
        confirmed: options.confirmed === 'true', expiresAt: options['expires-at'] }));
      return;
    }
    if (command === 'review-memory') {
      print(reviewMemory({ db, memoryId: options['memory-id'], action: options.action, replacement: options.replacement }));
      return;
    }
    if (command === 'list-memories') {
      print(listMemories({ db, config, includeRevoked: options['include-revoked'] === 'true' }));
      return;
    }
    if (command === 'work-log') {
      print(addWorkLog({ db, date: options.date, task: options.task, progress: options.progress,
        decision: options.decision, blocker: options.blocker, todo: options.todo,
        sourceMessageId: options['message-id'], sourceVersionId: options['version-id'] }));
      return;
    }
    if (command === 'learning-log') {
      print(addLearningLog({ db, date: options.date, topic: options.topic, understanding: options.understanding,
        question: options.question, selfTest: options['self-test'], reviewOn: options['review-on'],
        status: options.status, sourceMessageId: options['message-id'], sourceVersionId: options['version-id'] }));
      return;
    }
    if (command === 'enqueue-parse') {
      print(enqueueParse({ db, projectId: config.projectId, versionId: options['version-id'] }));
      return;
    }
    if (command === 'run-jobs') {
      print(await runJobs({ root, db, maxAttempts: options['max-attempts'] }));
      return;
    }
    if (command === 'integrity') {
      print(await integrityReport({ root, db }));
      return;
    }
    if (command === 'record-usage') {
      print(recordUsage({
        db, config, metric: options.metric, quantity: options.quantity, provider: options.provider || 'local',
        costMinor: options['cost-minor'], currency: options.currency,
        sourceVersionId: options['version-id'], note: options.note, occurredAt: options['occurred-at'],
      }));
      return;
    }
    if (command === 'usage-summary') {
      print(usageSummary({ db, config }));
      return;
    }
    if (command === 'delete-impact') {
      if (!options['source-id']) throw new Error('--source-id 必填');
      print(await deletionImpact({ root, db, config, sourceId: options['source-id'] }));
      return;
    }
    if (command === 'delete-source') {
      if (!options['source-id'] || !options['confirm-source-id']) {
        throw new Error('--source-id 和 --confirm-source-id 必填');
      }
      print(await deleteSource({
        root, db, config, sourceId: options['source-id'], confirmSourceId: options['confirm-source-id'],
      }));
      return;
    }
    if (command === 'export-catalog') {
      print(await exportCatalog({ root, db, output: options.output }));
      return;
    }
    if (command === 'backup') {
      print(await createBackup({ root, db }));
      return;
    }
    if (command === 'restore') {
      if (!options.backup || !options.target) throw new Error('--backup 和 --target 必填');
      print(await restoreBackup({ backupDir: options.backup, targetDir: options.target }));
      return;
    }
    throw new Error('未知命令；参见 README 的 CLI 示例');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
