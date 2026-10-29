import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { relay } from './relay.mjs';
import { summarize } from './stats.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const config = {
  iterations: 1000,
  samples: 3,
  latencies: [0, 10],
  warmup: 20,
  poolSize: 4,
  concurrency: 16,
  batchSize: 32,
};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const name = { '--iterations': 'iterations', '--samples': 'samples', '--latencies': 'latencies' }[
    args[i]
  ];
  if (!name || args[i + 1] === undefined)
    throw Error('Use --iterations N --samples N --latencies 0,10.');
  const values = args[i + 1].split(',').map(Number);
  if (
    values.some(
      (value) =>
        !Number.isSafeInteger(value) ||
        value < (name === 'latencies' ? 0 : 1) ||
        value > (name === 'latencies' ? 1000 : 100000),
    )
  )
    throw Error('Invalid benchmark limit.');
  if (name !== 'latencies' && values.length !== 1) throw Error('Expected one numeric limit.');
  config[name] = name === 'latencies' ? [...new Set(values)] : values[0];
}
const database = process.env.PGCLEAR_TEST_DATABASE_URL;
if (!database) throw Error('PGCLEAR_TEST_DATABASE_URL is required.');
let target;
try {
  target = new URL(database);
} catch {
  throw Error('Invalid benchmark database URL.');
}
if (
  !decodeURIComponent(target.pathname.slice(1)).endsWith('_test') ||
  [...target.searchParams.keys()].some((key) => key !== 'sslmode') ||
  !target.hostname ||
  target.hostname.startsWith('/') ||
  ![null, 'disable'].includes(target.searchParams.get('sslmode'))
)
  throw Error('Benchmarks require an explicit TCP _test database with TLS disabled.');
// Only benchmark-local comparator dependencies are installed; pgclear's runtime stays unchanged.
const fixture = JSON.parse(await readFile(new URL('./package.json', import.meta.url)));
for (const driver of ['pg', 'postgres']) {
  const installed = JSON.parse(
    await readFile(new URL(`./node_modules/${driver}/package.json`, import.meta.url)),
  );
  if (installed.version !== fixture.dependencies[driver])
    throw Error('Run npm ci --prefix benchmarks --ignore-scripts to match the comparator pin.');
}
await mkdir(join(root, '.benchmark-dist'), { recursive: true });
const directory = await mkdtemp(join(root, '.benchmark-dist/run-'));
console.log(`Benchmark output: ${directory}`);
await run('npm', ['run', 'build'], { cwd: root });
const [archive] = JSON.parse(
  (
    await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      cwd: root,
    })
  ).stdout,
);
await run('tar', ['-xzf', join(directory, archive.filename), '-C', directory]);
await symlink(join(root, 'node_modules'), join(directory, 'package/node_modules'), 'dir');
const entry = join(directory, 'package/dist/index.js');
const { connect } = await import(pathToFileURL(entry).href);
const client = await connect({ connectionString: database, tls: false });
let serverVersion;
try {
  const row = (
    await client.queryClassic('SELECT current_database() AS name,version() AS version', [])
  ).rows[0];
  if (!row.name.endsWith('_test')) throw Error('Connected to an unexpected database.');
  serverVersion = row.version;
} finally {
  await client.close();
}
const report = {
  status: 'running',
  createdAt: new Date().toISOString(),
  config,
  revision: (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
  workingTreeDirty: Boolean(
    (await run('git', ['status', '--porcelain'], { cwd: root })).stdout.trim(),
  ),
  artifactSha256: createHash('sha256')
    .update(await readFile(join(directory, archive.filename)))
    .digest('hex'),
  comparatorLockSha256: createHash('sha256')
    .update(await readFile(new URL('./package-lock.json', import.meta.url)))
    .digest('hex'),
  versions: fixture.dependencies,
  serverVersion,
  node: process.version,
  machine: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
  },
  notes: [
    'Measured client CPU/RSS exclude the relay and PostgreSQL processes.',
    'All profiles use the same bounded TCP relay; configured RTT is added delay, not measured total RTT.',
    'Prepared setup, connection/type discovery, warmup and cleanup are excluded from timing.',
    'Common value assertions are included. Results use object rows with matching int4/array/JSON mappings; native typed array/JSON bind helpers are used where required.',
    'Baseline pipelining is disabled. pipeline-probe enables comparator pipelines with bounded concurrency; pgclear stays sequential.',
    'Transactions use each driver public transaction API (pg uses explicit BEGIN/COMMIT on an acquired client).',
  ],
  measurements: [],
  summaries: [],
};
const drivers = ['pgclear', 'pg', 'postgres'];
const workloads = [
  'small',
  'prepared',
  'large',
  'arrays-json',
  'transaction',
  'pool',
  'pipeline-probe',
];
try {
  for (const addedRttMs of config.latencies) {
    const proxy = await relay(target.hostname, Number(target.port || 5432), addedRttMs);
    const proxied = new URL(target);
    proxied.hostname = '127.0.0.1';
    proxied.port = String(proxy.port);
    try {
      for (const workload of workloads)
        for (let sample = 0; sample < config.samples; sample++) {
          // Rotate driver order each sample to reduce systematic warm-cache/order bias.
          const order = drivers.map((_, i) => drivers[(i + sample) % drivers.length]);
          for (const driver of order) {
            const label = `${addedRttMs}ms-${workload}-${sample}-${driver}`;
            const output = join(directory, label + '.json');
            console.log(label);
            await run(
              process.execPath,
              [
                fileURLToPath(new URL('./worker.mjs', import.meta.url)),
                JSON.stringify({
                  driver,
                  workload,
                  sample,
                  addedRttMs,
                  ...config,
                  output,
                }),
              ],
              {
                cwd: root,
                timeout: 180000,
                maxBuffer: 1024 * 1024,
                env: {
                  ...process.env,
                  PGCLEAR_BENCH_DATABASE_URL: proxied.href,
                  PGCLEAR_BENCH_PACKAGE: entry,
                },
              },
            );
            const raw = JSON.parse(await readFile(output));
            const { latenciesMs, output: _output, ...measurement } = raw;
            report.measurements.push(measurement);
            await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
          }
        }
    } finally {
      await proxy.close();
    }
  }
  for (const addedRttMs of config.latencies)
    for (const workload of workloads)
      for (const driver of drivers) {
        const selected = report.measurements.filter(
          (row) =>
            row.driver === driver && row.workload === workload && row.addedRttMs === addedRttMs,
        );
        report.summaries.push({
          driver,
          workload,
          addedRttMs,
          operationsPerSecond: summarize(selected.map((row) => row.operationsPerSecond)),
          medianLatencyMs: summarize(selected.map((row) => row.latencyMs.median)),
          p95LatencyMs: summarize(selected.map((row) => row.latencyMs.p95)),
          p99LatencyMs: summarize(selected.map((row) => row.latencyMs.p99)),
          clientCpuMs: summarize(selected.map((row) => row.cpuMs.user + row.cpuMs.system)),
          sampledPeakRssBytes: summarize(selected.map((row) => row.memoryBytes.sampledPeakRss)),
        });
      }
  report.status = 'passed';
} finally {
  if (report.status !== 'passed') report.status = 'failed';
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(
    join(root, '.benchmark-dist/latest.json'),
    JSON.stringify({ directory, status: report.status }, null, 2) + '\n',
  );
}
console.log(`Benchmark ${report.status}. Evidence: ${join(directory, 'report.json')}`);
