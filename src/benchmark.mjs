import { performance } from 'node:perf_hooks';
import { cpus, platform, release } from 'node:os';
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
const sandbox = await mkdtemp(join(tmpdir(), 'pet-learning-benchmark-'));
await ensureProjectDirs(sandbox);
const config = { schemaVersion: 4, projectId: 'synthetic-benchmark', dataPolicy: { defaultConfidentiality: 'synthetic' } };
const db = openCatalog(sandbox, config);

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

try {
  for (const document of corpus.documents) {
    const file = join(sandbox, `${document.id}.md`);
    await writeFile(file, `${document.content}\n`, 'utf8');
    const intake = await intakeFile({ root: sandbox, config, db, file, title: document.title, confidentiality: 'synthetic' });
    await parseVersion({ root: sandbox, db, versionId: intake.versionId });
  }
  const queries = corpus.documents.flatMap((document) => document.keywords);
  for (const query of queries) searchEvidence({ db, query, limit: 10 });
  const timings = [];
  for (let repeat = 0; repeat < 10; repeat += 1) {
    for (const query of queries) {
      const start = performance.now();
      searchEvidence({ db, query, limit: 10 });
      timings.push(performance.now() - start);
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model || 'unknown', logicalCpus: cpus().length },
    dataset: { syntheticDocuments: corpus.documents.length, uniqueQueries: queries.length, measuredQueries: timings.length, cacheState: 'warm' },
    latencyMs: {
      p50: Number(percentile(timings, 0.5).toFixed(3)),
      p95: Number(percentile(timings, 0.95).toFixed(3)),
      max: Number(Math.max(...timings).toFixed(3)),
    },
    scope: 'SQLite FTS/local substring retrieval only; excludes model, OCR, ASR, network and UI rendering.',
  };
  await mkdir(join(root, 'eval', 'results'), { recursive: true });
  await writeFile(join(root, 'eval', 'results', 'performance-latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  db.close();
}
