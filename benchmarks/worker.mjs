import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { summarize } from './stats.mjs';

const settings = JSON.parse(process.argv[2]);
const { driver, workload, iterations, warmup, poolSize, concurrency, batchSize } = settings;
const url = process.env.PGCLEAR_BENCH_DATABASE_URL;
if (!url || !decodeURIComponent(new URL(url).pathname.slice(1)).endsWith('_test'))
  throw Error('Benchmark requires an explicit test database.');
const probe = workload === 'pipeline-probe';
const pooled = workload === 'pool' || workload === 'transaction';
const capacity = pooled ? poolSize : 1;
const marker = 'pgclear_bench_' + process.pid;
let query, transaction, close, prepared;
const modes = {
  prepared: workload === 'prepared' || probe,
  pipeline: probe && driver !== 'pgclear',
};

if (driver === 'pgclear') {
  const api = await import(pathToFileURL(process.env.PGCLEAR_BENCH_PACKAGE).href);
  const options = { connectionString: url, applicationName: marker, tls: false };
  const client = pooled
    ? api.createPool({ ...options, maxConnections: capacity })
    : await api.connect(options);
  query = async (text, values = []) => {
    const bound =
      workload === 'arrays-json'
        ? [api.param(values[0], api.builtin.int4Array), api.json(values[1])]
        : values;
    return (await client.queryClassic(text, bound)).rows;
  };
  transaction = async (value) =>
    client.transaction(
      async (tx) => (await tx.queryClassic('SELECT $1::integer AS value', [value])).rows,
    );
  if (modes.prepared) prepared = await client.prepare('SELECT $1::integer AS value');
  if (prepared) query = async (_text, values) => (await prepared.query(values)).rows;
  close = async () => {
    await prepared?.close();
    await client.close();
  };
} else if (driver === 'pg') {
  const { default: pg } = await import('pg');
  const options = {
    connectionString: url,
    ssl: false,
    application_name: marker,
    pipeline: modes.pipeline,
  };
  const client = pooled ? new pg.Pool({ ...options, max: capacity }) : new pg.Client(options);
  if (!pooled) await client.connect();
  const execute = (connection, text, values = []) =>
    connection.query({
      text,
      values,
      queryMode: 'extended',
      ...(modes.prepared ? { name: 'benchmark_statement' } : {}),
    });
  query = async (text, values) => (await execute(client, text, values)).rows;
  transaction = async (value) => {
    const session = await client.connect();
    try {
      await execute(session, 'BEGIN');
      const result = (await execute(session, 'SELECT $1::integer AS value', [value])).rows;
      await execute(session, 'COMMIT');
      return result;
    } catch (error) {
      await execute(session, 'ROLLBACK');
      throw error;
    } finally {
      session.release();
    }
  };
  close = () => client.end();
} else if (driver === 'postgres') {
  const { default: postgres } = await import('postgres');
  const client = postgres(url, {
    max: capacity,
    ssl: false,
    prepare: modes.prepared,
    // Zero prevents transaction reservation in this version. Baseline pool queries reserve a
    // connection explicitly; all other baseline workloads submit one operation at a time.
    max_pipeline: modes.pipeline ? batchSize : 1,
    fetch_types: true,
    idle_timeout: 0,
    max_lifetime: 0,
    onnotice() {},
    connection: { application_name: marker },
  });
  // Populate the driver's built-in array OID map before creating typed array parameters.
  await client.unsafe('SELECT 1', [], { prepare: false, simple: false });
  const execute = (connection, text, values = []) =>
    connection.unsafe(
      text,
      workload === 'arrays-json' ? [client.array(values[0], 23), client.json(values[1])] : values,
      { prepare: modes.prepared, simple: false },
    );
  query = async (text, values) => {
    if (workload !== 'pool') return execute(client, text, values);
    const session = await client.reserve();
    try {
      return await execute(session, text, values);
    } finally {
      session.release();
    }
  };
  transaction = (value) =>
    client.begin(async (tx) =>
      tx.unsafe('SELECT $1::integer AS value', [value], { prepare: false, simple: false }),
    );
  close = () => client.end({ timeout: 5 });
} else throw Error('Unknown driver.');

const sql = 'SELECT $1::integer AS value';
const operations =
  workload === 'large'
    ? Math.max(10, Math.ceil(iterations / 20))
    : workload === 'transaction'
      ? Math.max(10, Math.ceil(iterations / 10))
      : iterations;
const lanes = workload === 'pool' ? concurrency : probe ? batchSize : 1;
const run = async (value) => {
  if (workload === 'large') {
    const rows = await query('SELECT generate_series(1,1000)::integer AS value');
    assert.equal(rows.length, 1000);
    assert.equal(rows[0].value, 1);
    assert.equal(rows.at(-1).value, 1000);
  } else if (workload === 'arrays-json') {
    const rows = await query('SELECT $1::integer[] AS numbers,$2::jsonb AS document', [
      [1, 2, 3, 4, 5],
      { ok: true, value: 42, items: [1, 2, 3] },
    ]);
    assert.deepEqual(rows[0].numbers, [1, 2, 3, 4, 5]);
    assert.deepEqual(rows[0].document, { ok: true, value: 42, items: [1, 2, 3] });
  } else {
    const rows = workload === 'transaction' ? await transaction(value) : await query(sql, [value]);
    assert.equal(rows[0].value, value);
  }
};
try {
  // Establish prepared caches, then warm the same concurrency used by the measured workload.
  await run(-1);
  const actualWarmupOperations = Math.max(warmup, lanes);
  await Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      for (let i = lane; i < actualWarmupOperations; i += lanes) await run(i);
    }),
  );
  let next = 0;
  const latencies = [];
  const memoryStart = process.memoryUsage();
  let sampledPeakRss = memoryStart.rss;
  const sampler = setInterval(() => {
    sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss);
  }, 10);
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  try {
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        for (;;) {
          const index = next++;
          if (index >= operations) return;
          const began = performance.now();
          await run(index);
          latencies.push(performance.now() - began);
        }
      }),
    );
  } finally {
    clearInterval(sampler);
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const memoryEnd = process.memoryUsage();
  sampledPeakRss = Math.max(sampledPeakRss, memoryEnd.rss);
  await writeFile(
    settings.output,
    JSON.stringify({
      ...settings,
      modes,
      operations,
      lanes,
      actualWarmupOperations: actualWarmupOperations + 1,
      elapsedMs,
      operationsPerSecond: (operations / elapsedMs) * 1000,
      latencyMs: summarize(latencies),
      cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
      memoryBytes: {
        rssStart: memoryStart.rss,
        rssEnd: memoryEnd.rss,
        sampledPeakRss,
        heapStart: memoryStart.heapUsed,
        heapEnd: memoryEnd.heapUsed,
      },
      latenciesMs: latencies,
    }) + '\n',
  );
} finally {
  await close();
}
