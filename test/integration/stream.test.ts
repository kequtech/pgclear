import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import {
  builtin,
  createPool,
  defaultCodecs,
  json,
  param,
  sql,
  type RowStream,
} from '../../src/index.js';
import { databaseUrl, testConnection } from '../helpers/database.js';

const within = { timeout: 10000 };
async function collect<T>(stream: RowStream<T>): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of stream) rows.push(row);
  return rows;
}

test(
  'streams span bounded portal batches and return metadata and final native counts',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      for (const [count, batchSize] of [
        [0, 2],
        [1, 2],
        [2, 2],
        [7, 2],
        [201, 100],
      ]) {
        const stream = client.stream(
          sql<{ n: number }>`SELECT generate_series(1, ${count!}::integer) AS n`,
          { batchSize: batchSize! },
        );
        assert.equal((await stream.fields)[0]!.dataTypeOid, 23);
        assert.deepEqual(
          await collect(stream),
          Array.from({ length: count! }, (_, i) => ({ n: i + 1 })),
        );
        assert.deepEqual(await stream.completion, {
          status: 'complete',
          result: {
            command: 'SELECT',
            commandTag: `SELECT ${count! % batchSize!}`,
            rowCount: BigInt(count! % batchSize!),
          },
        });
        await stream.close();
        await stream.close();
        assert.equal((await client.queryClassic('SELECT 42 AS n', [])).rows[0]!.n, 42);
      }
      const empty = client.stream('');
      assert.deepEqual(await collect(empty), []);
      assert.deepEqual(await empty.completion, {
        status: 'complete',
        result: { command: '', commandTag: '', rowCount: null },
      });
    } finally {
      await client.close();
    }
  },
);

test(
  'for-await early exit and explicit Close wait for cleanup and never invent final counts',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      for (const batchSize of [1, 3, 100]) {
        const stream = client.stream('SELECT generate_series(1,9) AS n', { batchSize });
        for await (const row of stream) {
          assert.equal(row.n, 1);
          break;
        }
        assert.deepEqual(await stream.completion, { status: 'closed' });
        assert.equal((await client.queryClassic('SELECT 2 AS n', [])).rows[0]!.n, 2);
      }
      const stream = client.stream('SELECT generate_series(1,100) AS n', { batchSize: 2 });
      await stream.fields;
      const closed = stream.close();
      assert.equal(stream.close(), closed);
      await closed;
      assert.deepEqual(await collect(stream), []);
      assert.deepEqual(await stream.completion, { status: 'closed' });
    } finally {
      await client.close();
    }
  },
);

test('streams enforce one consumer, one read and exclusive scope ownership', within, async () => {
  const { client } = await testConnection();
  try {
    const prepared = await client.prepare('SELECT 42');
    const stream = client.stream('SELECT generate_series(1,3)', { batchSize: 1 });
    const iterator = stream[Symbol.asyncIterator]();
    assert.throws(() => stream[Symbol.asyncIterator](), { code: 'PGCLEAR_BUSY' });
    const first = iterator.next();
    await assert.rejects(iterator.next(), { code: 'PGCLEAR_BUSY' });
    await assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_BUSY' });
    await assert.rejects(client.describe('SELECT 1'), { code: 'PGCLEAR_BUSY' });
    await assert.rejects(client.prepare('SELECT 1'), { code: 'PGCLEAR_BUSY' });
    await assert.rejects(prepared.query(), { code: 'PGCLEAR_BUSY' });
    await assert.rejects(prepared.close(), { code: 'PGCLEAR_BUSY' });
    await assert.rejects(
      client.transaction(async () => {}),
      { code: 'PGCLEAR_BUSY' },
    );
    const competing = client.stream('SELECT 2');
    await assert.rejects(competing.completion, { code: 'PGCLEAR_BUSY' });
    await first;
    await iterator.return!();
    await prepared.close();
  } finally {
    await client.close();
  }
});

test(
  'stream parameters, array rows and isolated codecs preserve ordinary conversion behavior',
  within,
  async () => {
    const { client } = await testConnection({
      codecs: defaultCodecs.with({
        oid: 23,
        text: { encode: String, decode: (value) => 'n:' + value },
      }),
    });
    const { client: ordinary } = await testConnection();
    try {
      const stream = client.stream<readonly [string, unknown, unknown, Uint8Array]>(
        [
          'SELECT $1::int AS n, $2::jsonb AS n, $3::numeric[], $4::bytea',
          [
            42,
            json({ yes: true }),
            param(['9007199254740993.25', null], builtin.numericArray),
            new Uint8Array([0, 255]),
          ],
        ],
        { rowMode: 'array', batchSize: 1 },
      );
      assert.deepEqual(await collect(stream), [
        ['n:42', { yes: true }, ['9007199254740993.25', null], new Uint8Array([0, 255])],
      ]);
      assert.deepEqual(await collect(ordinary.stream('SELECT 42::int AS n')), [{ n: 42 }]);
      const duplicate = client.stream('SELECT 1 AS n, 2 AS n');
      await assert.rejects(collect(duplicate), { code: 'PGCLEAR_DECODE', outcome: 'confirmed' });
      assert.equal((await client.queryClassic('SELECT 3 AS n', [])).rows[0]!.n, 'n:3');
    } finally {
      await Promise.all([client.close(), ordinary.close()]);
    }
  },
);

test(
  'local stream input errors and server/decoder failures settle all surfaces and recover ownership',
  within,
  async () => {
    const { client } = await testConnection({
      codecs: defaultCodecs.with({
        oid: 23,
        text: {
          encode: String,
          decode(value) {
            if (value === '2') throw Error('fixture');
            return Number(value);
          },
        },
      }),
    });
    try {
      for (const options of [
        { batchSize: 0 },
        { batchSize: -1 },
        { batchSize: 1.5 },
        { batchSize: 0x80000000 },
        { batchSize: null },
        { rowMode: 'tuple' },
      ]) {
        const stream = client.stream('SELECT 1', options as never);
        await assert.rejects(stream.fields, { code: 'PGCLEAR_CONFIGURATION' });
        await assert.rejects(stream.completion, { code: 'PGCLEAR_CONFIGURATION' });
        await assert.rejects(collect(stream), { code: 'PGCLEAR_CONFIGURATION' });
      }
      const invalid = client.stream(['SELECT $1', [undefined] as never]);
      await assert.rejects(invalid.completion, { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' });
      const syntax = client.stream('SELECT FROM');
      await assert.rejects(syntax.fields, { code: '42601' });
      await assert.rejects(collect(syntax), { code: '42601' });
      await assert.rejects(syntax.completion, { code: '42601' });
      const server = client.stream('SELECT 1/(n-3) AS n FROM generate_series(1,4) n', {
        batchSize: 1,
      });
      await assert.rejects(collect(server), { code: '22012' });
      const decode = client.stream('SELECT generate_series(1,4) AS n', { batchSize: 1 });
      await assert.rejects(collect(decode), { code: 'PGCLEAR_DECODE', outcome: 'confirmed' });
      assert.deepEqual((await client.queryClassic('SELECT 3 AS n', [])).rows, [{ n: 3 }]);
    } finally {
      await client.close();
    }
  },
);

test(
  'transactions and savepoints stream through their creating scope and recover partial closes',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.transaction(async (tx) => {
        const parent = client.stream('SELECT 1');
        await assert.rejects(parent.completion, { code: 'PGCLEAR_BUSY' });
        const stream = tx.stream('SELECT generate_series(1,4) AS n', { batchSize: 1 });
        for await (const row of stream) {
          assert.equal(row.n, 1);
          break;
        }
        assert.deepEqual(await stream.completion, { status: 'closed' });
        await tx.savepoint(async (child) => {
          assert.deepEqual(await collect(child.stream('SELECT 2 AS n')), [{ n: 2 }]);
        });
        await assert.rejects(
          tx.savepoint(async (child) => {
            await collect(child.stream('SELECT 1/0'));
          }),
          { code: '22012' },
        );
        assert.deepEqual((await tx.queryClassic('SELECT 3 AS n', [])).rows, [{ n: 3 }]);
      });
      assert.equal(client.transactionStatus, 'idle');
    } finally {
      await client.close();
    }
  },
);

test(
  'abandoned callback streams fail success, clean portals and roll back before reuse',
  within,
  async () => {
    const pool = createPool({ connectionString: databaseUrl(), maxConnections: 1 });
    try {
      let escaped: RowStream<unknown> | undefined;
      await assert.rejects(
        pool.withSession(async (session) => {
          escaped = session.stream('SELECT generate_series(1,10)', { batchSize: 1 });
          await escaped.fields;
        }),
        { code: 'PGCLEAR_BUSY' },
      );
      assert.deepEqual(await escaped!.completion, { status: 'closed' });
      assert.equal(pool.stats.total, 0);
      const lease = await pool.acquire();
      const pid = lease.info.backendPid;
      await lease.queryClassic('CREATE TEMP TABLE abandoned_stream (n integer)', []);
      await assert.rejects(
        lease.transaction(async (tx) => {
          await tx.queryClassic('INSERT INTO abandoned_stream VALUES (1)', []);
          const stream = tx.stream('SELECT generate_series(1,10)', { batchSize: 1 });
          await stream.fields;
        }),
        { code: 'PGCLEAR_BUSY' },
      );
      assert.equal(
        (await lease.queryClassic('SELECT count(*) AS n FROM abandoned_stream', [])).rows[0]!.n,
        0n,
      );
      const stream = lease.stream('SELECT generate_series(1,10)', { batchSize: 1 });
      await stream.fields;
      await lease.release();
      assert.deepEqual(await stream.completion, { status: 'closed' });
      const next = await pool.acquire();
      assert.notEqual(next.info.backendPid, pid);
      await next.release();
    } finally {
      await pool.close();
    }
  },
);

test('streams limit bytes per batch rather than total result size', within, async () => {
  const { client } = await testConnection({ maxResultBytes: 128 });
  try {
    const rows = await collect(
      client.stream("SELECT repeat('x', 20) AS n FROM generate_series(1,100)", { batchSize: 1 }),
    );
    assert.equal(rows.length, 100);
    const oversized = client.stream("SELECT repeat('x',200) AS n", { batchSize: 1 });
    await assert.rejects(collect(oversized), { code: 'PGCLEAR_RESULT_LIMIT' });
    await assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_CLOSED' });
  } finally {
    await client.close();
  }
});

for (const boundary of ['active', 'suspended'] as const)
  test(`stream abort at ${boundary} retires transport and clears listeners`, within, async () => {
    const { client } = await testConnection();
    const controller = new AbortController();
    try {
      const stream = client.stream(
        boundary === 'active' ? 'SELECT pg_sleep(30)' : 'SELECT generate_series(1,10) AS n',
        { batchSize: 1, signal: controller.signal },
      );
      if (boundary === 'suspended') await stream[Symbol.asyncIterator]().next();
      const failed = assert.rejects(stream.completion, {
        code: 'PGCLEAR_ABORTED',
        outcome: 'confirmed',
      });
      controller.abort();
      await failed;
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_CLOSED' });
    } finally {
      await client.close();
    }
  });

test(
  'stream deadlines include paused consumers and queued close leaves earlier work intact',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const blocking = client.queryClassic('SELECT pg_sleep(0.05)', []);
      const queued = client.stream('SELECT 1');
      await queued.close();
      await assert.rejects(queued.fields, { code: 'PGCLEAR_ABORTED' });
      assert.deepEqual(await queued.completion, { status: 'closed' });
      await blocking;
      const timeout = client.stream('SELECT generate_series(1,10)', {
        batchSize: 1,
        timeoutMs: 25,
      });
      await timeout.fields;
      await assert.rejects(timeout.completion, { code: 'PGCLEAR_TIMEOUT', outcome: 'confirmed' });
    } finally {
      await client.close();
    }
  },
);

test(
  'partial write-stream close commits server effects without claiming a final command',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.queryClassic('CREATE TEMP TABLE stream_writes (n integer)', []);
      const stream = client.stream(
        'INSERT INTO stream_writes SELECT generate_series(1,7) RETURNING n',
        { batchSize: 1 },
      );
      for await (const row of stream) {
        assert.equal(row.n, 1);
        break;
      }
      assert.deepEqual(await stream.completion, { status: 'closed' });
      assert.equal(
        (await client.queryClassic('SELECT count(*) AS n FROM stream_writes', [])).rows[0]!.n,
        7n,
      );
      assert.equal(client.transactionStatus, 'idle');
      const command = client.stream('UPDATE stream_writes SET n=n+10');
      assert.deepEqual(await collect(command), []);
      assert.deepEqual(await command.completion, {
        status: 'complete',
        result: { command: 'UPDATE', commandTag: 'UPDATE 7', rowCount: 7n },
      });
    } finally {
      await client.close();
    }
  },
);

test(
  'closing a connection with an idle consumer closes the portal without waiting for iteration',
  within,
  async () => {
    const { client } = await testConnection();
    const stream = client.stream('SELECT generate_series(1,100)', { batchSize: 1 });
    await stream.fields;
    await client.close();
    assert.deepEqual(await stream.completion, { status: 'closed' });
    assert.deepEqual(await collect(stream), []);
  },
);

test(
  'whole-callback deadlines close paused streams and release capacity without waiting for user JavaScript',
  within,
  async () => {
    const pool = createPool({ connectionString: databaseUrl(), maxConnections: 1 });
    let escaped: RowStream<unknown> | undefined;
    try {
      await assert.rejects(
        pool.withSession(
          async (session) => {
            escaped = session.stream('SELECT generate_series(1,10)', { batchSize: 1 });
            await escaped.fields;
            await new Promise(() => {});
          },
          { timeoutMs: 50 },
        ),
        { code: 'PGCLEAR_TIMEOUT' },
      );
      await assert.rejects(escaped!.completion, { code: 'PGCLEAR_TIMEOUT' });
      assert.equal(pool.stats.total, 0);
      assert.equal((await pool.queryClassic('SELECT 3 AS n', [])).rows[0]!.n, 3);
    } finally {
      await pool.close();
    }
  },
);
