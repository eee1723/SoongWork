import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureProjectDirs } from './lib/project.mjs';
import { openCatalog } from './lib/catalog.mjs';
import { intakeFile } from './lib/intake.mjs';
import { parseVersion } from './lib/parsers.mjs';
import { searchEvidence } from './lib/evidence.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const corpus = JSON.parse(await readFile(join(root, 'eval', 'corpus.json'), 'utf8'));
const sandbox = await mkdtemp(join(tmpdir(), 'pet-learning-eval-'));
await ensureProjectDirs(sandbox);
const config = {
  schemaVersion: 4,
  projectId: 'synthetic-eval',
  name: '虚构评估项目',
  dataPolicy: { defaultConfidentiality: 'synthetic' },
};
const db = openCatalog(sandbox, config);
const sourceByDocument = new Map();

try {
  for (const document of corpus.documents) {
    const file = join(sandbox, `${document.id}.md`);
    await writeFile(file, `${document.content}\n`, 'utf8');
    const intake = await intakeFile({
      root: sandbox, config, db, file, title: document.title, sourceDomain: 'synthetic_eval', confidentiality: 'synthetic',
    });
    sourceByDocument.set(document.id, intake.sourceId);
    await parseVersion({ root: sandbox, db, versionId: intake.versionId });
  }

  const cases = [];
  let found = 0;
  for (const document of corpus.documents) {
    for (const query of document.keywords) {
      const results = searchEvidence({ db, query, limit: 10 });
      const matched = results.some((result) => result.sourceId === sourceByDocument.get(document.id));
      if (matched) found += 1;
      cases.push({ query, expectedDocument: document.id, matched, returned: results.map((result) => result.title) });
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    corpusNotice: corpus.notice,
    documents: corpus.documents.length,
    queries: cases.length,
    recallAt10: found / cases.length,
    passed: found / cases.length >= 0.9,
    cases,
  };
  await mkdir(join(root, 'eval', 'results'), { recursive: true });
  await writeFile(join(root, 'eval', 'results', 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ documents: report.documents, queries: report.queries, recallAt10: report.recallAt10, passed: report.passed }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  db.close();
}
