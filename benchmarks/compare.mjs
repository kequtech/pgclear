import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { summarize } from './stats.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: {
    before: { type: 'string' },
    after: { type: 'string' },
    iterations: { type: 'string', default: '30000' },
    samples: { type: 'string', default: '5' },
    workloads: { type: 'string', default: 'large,wide,small,pool,transaction' },
  },
});
const workloads = [...new Set(values.workloads.split(','))];
if (
  workloads.some(
    (name) =>
      ![
        'small',
        'prepared',
        'large',
        'wide',
        'arrays-json',
        'transaction',
        'pool',
        'pipeline-probe',
      ].includes(name),
  )
)
  throw Error('Unknown benchmark workload.');
const config = {
  iterations: Number(values.iterations),
  samples: Number(values.samples),
  workloads,
  warmup: 100,
  poolSize: 4,
  concurrency: 16,
  batchSize: 32,
  transport: 'direct',
  addedRttMs: 0,
};
for (const key of ['iterations', 'samples'])
  if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > 100000)
    throw Error('Invalid benchmark limit.');
if (!values.before || !values.after)
  throw Error('Supply --before and --after pgclear package archives.');
const database = process.env.PGCLEAR_TEST_DATABASE_URL;
if (!database) throw Error('PGCLEAR_TEST_DATABASE_URL is required.');
const target = new URL(database);
if (
  !target.pathname.endsWith('_test') ||
  !target.hostname ||
  target.hostname.startsWith('/') ||
  [...target.searchParams.keys()].some((key) => key !== 'sslmode') ||
  ![null, 'disable'].includes(target.searchParams.get('sslmode'))
)
  throw Error('Comparisons require a TCP _test database with TLS disabled.');
const comparator = JSON.parse(
  await readFile(new URL('./node_modules/pg/package.json', import.meta.url)),
);
const pinned = JSON.parse(await readFile(new URL('./package.json', import.meta.url)));
if (comparator.version !== pinned.dependencies.pg)
  throw Error('Install the pinned benchmark dependencies first.');
await mkdir(join(root, '.benchmark-dist'), { recursive: true });
const directory = await mkdtemp(join(root, '.benchmark-dist/compare-'));
console.log(`Comparison output: ${directory}`);
const entries = {},
  artifacts = {};
for (const variant of ['before', 'after']) {
  const archive = resolve(values[variant]);
  const destination = join(directory, variant);
  await mkdir(destination);
  await run('tar', ['-xzf', archive, '-C', destination]);
  const manifest = JSON.parse(await readFile(join(destination, 'package/package.json')));
  if (manifest.name !== '@kequtech/pgclear') throw Error('Expected a pgclear package.');
  entries[variant] = join(destination, 'package/dist/index.js');
  artifacts[variant] = {
    archive: basename(archive),
    version: manifest.version,
    sha256: createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
  };
}
const { connect } = await import(pathToFileURL(entries.before).href);
const probe = await connect({ connectionString: database, tls: false });
let serverVersion;
try {
  serverVersion = (await probe.queryClassic('SELECT version() AS version')).rows[0].version;
} finally {
  await probe.close();
}
const report = {
  status: 'running',
  createdAt: new Date().toISOString(),
  config,
  artifacts,
  comparatorVersion: comparator.version,
  node: process.version,
  serverVersion,
  machine: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
  },
  workerSha256: createHash('sha256')
    .update(await readFile(new URL('./worker.mjs', import.meta.url)))
    .digest('hex'),
  notes: [
    'Immutable archives are unpacked separately; no build or package replacement occurs during measurement.',
    'Before/after order reverses each repetition; pg is a contemporaneous control. All variants run serially with the same SQL/assertions.',
    'Each worker is a fresh process. Setup, discovery, preparation, warmup and cleanup are excluded; CPU/RSS exclude PostgreSQL.',
  ],
  measurements: [],
  summaries: [],
};
try {
  for (const workload of workloads)
    for (let sample = 0; sample < config.samples; sample++) {
      for (const variant of sample % 2 ? ['pg', 'after', 'before'] : ['before', 'after', 'pg']) {
        const label = `${workload}-${sample}-${variant}`;
        console.log(label);
        const output = join(directory, label + '.json');
        await run(
          process.execPath,
          [
            fileURLToPath(new URL('./worker.mjs', import.meta.url)),
            JSON.stringify({
              ...config,
              driver: variant === 'pg' ? 'pg' : 'pgclear',
              workload,
              sample,
              output,
            }),
          ],
          {
            cwd: root,
            timeout: 180000,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              PGCLEAR_BENCH_DATABASE_URL: database,
              PGCLEAR_BENCH_PACKAGE: entries[variant === 'after' ? 'after' : 'before'],
            },
          },
        );
        const { latenciesMs, output: _output, ...measurement } = JSON.parse(await readFile(output));
        report.measurements.push({ variant, ...measurement });
        await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      }
    }
  for (const workload of workloads)
    for (const variant of ['before', 'after', 'pg']) {
      const selected = report.measurements.filter(
        (row) => row.workload === workload && row.variant === variant,
      );
      report.summaries.push({
        workload,
        variant,
        operationsPerSecond: summarize(selected.map((row) => row.operationsPerSecond)),
        clientCpuMs: summarize(selected.map((row) => row.cpuMs.user + row.cpuMs.system)),
        p95LatencyMs: summarize(selected.map((row) => row.latencyMs.p95)),
        sampledPeakRssBytes: summarize(selected.map((row) => row.memoryBytes.sampledPeakRss)),
      });
    }
  report.status = 'passed';
} finally {
  if (report.status !== 'passed') report.status = 'failed';
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`Comparison ${report.status}. Evidence: ${join(directory, 'report.json')}`);
