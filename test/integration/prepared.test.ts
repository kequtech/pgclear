import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import {
  builtin,
  createPool,
  defaultCodecs,
  json,
  param,
  type Codec,
  type PreparedStatement,
} from '../../src/index.js';
import { databaseUrl, testConnection } from '../helpers/database.js';

const within = { timeout: 10000 };
const countSql =
  "SELECT count(*) AS n FROM pg_prepared_statements WHERE name LIKE 'pgclear_statement_%'";

test(
  'prepared metadata and valid/invalid/valid reuse preserve the confirmed name',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const prepared = await client.prepare('SELECT $1::jsonb AS value');
      assert.deepEqual(prepared.description.parameterTypes, [3802]);
      assert.equal(prepared.description.fields[0]!.name, 'value');
      assert.ok(Object.isFrozen(prepared.description));
      const first = prepared.query([json({ first: 1 })]);
      const invalid = assert.rejects(prepared.query([json({ invalid: 1n })]), {
        code: 'PGCLEAR_ENCODE',
        outcome: 'not-sent',
      });
      const last = prepared.query([json({ last: 3 })]);
      const result = await first;
      assert.deepEqual(result.rows, [{ value: { first: 1 } }]);
      assert.equal(result.rowCount, 1);
      await invalid;
      assert.deepEqual((await last).rows, [{ value: { last: 3 } }]);
      for (const values of [[], [undefined], Array(1), [json(1), json(2)]])
        await assert.rejects(prepared.query(values as never), {
          code: 'PGCLEAR_ENCODE',
          outcome: 'not-sent',
        });
      assert.deepEqual((await prepared.query([json(null)])).rows, [{ value: null }]);
      assert.equal((await client.queryClassic(countSql, [])).rows[0]!.n, '1');
      await prepared.close();
      await prepared.close();
      await assert.rejects(prepared.query([json(4)]), { code: 'PGCLEAR_EXPIRED' });
      assert.equal((await client.queryClassic(countSql, [])).rows[0]!.n, '0');
    } finally {
      await client.close();
    }
  },
);

test(
  'prepared executions and Close preserve FIFO even when an encoder reenters',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.queryClassic('CREATE TEMP TABLE prepared_order (id serial, label text)', []);
      const prepared = await client.prepare('INSERT INTO prepared_order(label) VALUES ($1)');
      let closing: Promise<void> | undefined;
      let rejected: Promise<void> | undefined;
      const codec: Codec<string> = {
        oid: 25,
        text: {
          encode(value) {
            closing = prepared.close();
            rejected = assert.rejects(prepared.query(['too late']), { code: 'PGCLEAR_EXPIRED' });
            return value;
          },
          decode: String,
        },
      };
      const first = prepared.query(['first']);
      const second = prepared.query([param('second', codec)]);
      await Promise.all([first, second, closing, rejected]);
      assert.deepEqual(
        (await client.queryClassic('SELECT label FROM prepared_order ORDER BY id', [])).rows,
        [{ label: 'first' }, { label: 'second' }],
      );
      assert.equal((await client.queryClassic(countSql, [])).rows[0]!.n, '0');
    } finally {
      await client.close();
    }
  },
);

test(
  'prepared array mode, explicit parameters and isolated codecs use the ordinary result path',
  within,
  async () => {
    const codec: Codec<string> = {
      oid: 23,
      text: { encode: String, decode: (value) => 'int:' + value },
    };
    const { client } = await testConnection({ codecs: defaultCodecs.with(codec) });
    const { client: ordinary } = await testConnection();
    try {
      const prepared = await client.prepare({
        text: 'SELECT $1 AS n, $2::numeric[] AS n, $3::bytea AS bytes',
        parameterTypes: [23, 1231, 17],
      });
      const values = [
        param('42', codec),
        param(['9007199254740993.25', null], builtin.numericArray),
        new Uint8Array([0, 255]),
      ];
      await assert.rejects(prepared.query(values), {
        code: 'PGCLEAR_DECODE',
        outcome: 'confirmed',
      });
      assert.deepEqual((await prepared.query(values, { rowMode: 'array' })).rows, [
        ['int:42', ['9007199254740993.25', null], new Uint8Array([0, 255])],
      ]);
      const other = await ordinary.prepare('SELECT $1::integer AS n');
      assert.deepEqual((await other.query([42])).rows, [{ n: 42 }]);
      await Promise.all([prepared.close(), other.close()]);
    } finally {
      await Promise.all([client.close(), ordinary.close()]);
    }
  },
);

test(
  'preparation errors clean names and confirmed executions recover from server and decoder errors',
  within,
  async () => {
    const { client } = await testConnection({
      codecs: defaultCodecs.with({
        oid: 23,
        text: {
          encode: String,
          decode(value: string) {
            if (value === '2') throw Error('fixture');
            return Number(value);
          },
        },
      }),
    });
    try {
      await assert.rejects(client.prepare('SELECT FROM'), { code: '42601' });
      await assert.rejects(client.prepare('SELECT $1 IS NULL'), { code: '42P18' });
      await assert.rejects(client.prepare({ text: 'SELECT 1', values: [] } as never), {
        code: 'PGCLEAR_ENCODE',
      });
      assert.equal((await client.queryClassic(countSql, [])).rows[0]!.n, '0');
      const prepared = await client.prepare('SELECT 12 / $1::integer AS n');
      await assert.rejects(prepared.query([0]), { code: '22012' });
      await assert.rejects(prepared.query([6]), { code: 'PGCLEAR_DECODE', outcome: 'confirmed' });
      assert.deepEqual((await prepared.query([3])).rows, [{ n: 4 }]);
      await prepared.close();
    } finally {
      await client.close();
    }
  },
);

test(
  'lease and session callback expiry drain accepted preparation/execution and dispose before reuse',
  within,
  async () => {
    const pool = createPool({ connectionString: databaseUrl(), maxConnections: 1 });
    try {
      const lease = await pool.acquire();
      const pid = lease.info.backendPid;
      const creating = lease.prepare('SELECT $1::integer AS n');
      const release = lease.release();
      const prepared = await creating;
      await release;
      await assert.rejects(prepared.query([1]), { code: 'PGCLEAR_EXPIRED' });
      await prepared.close();
      const next = await pool.acquire();
      assert.equal(next.info.backendPid, pid);
      assert.equal((await next.queryClassic(countSql, [])).rows[0]!.n, '0');
      await next.release();
      let escaped: PreparedStatement | undefined;
      let pending: Promise<unknown> | undefined;
      await pool.withSession(async (session) => {
        escaped = await session.prepare('SELECT $1::integer AS n');
        pending = escaped.query([7]);
      });
      assert.deepEqual(((await pending) as { rows: unknown }).rows, [{ n: 7 }]);
      await assert.rejects(escaped!.query([8]), { code: 'PGCLEAR_EXPIRED' });
      assert.equal((await pool.queryClassic(countSql, [])).rows[0]!.n, '0');
    } finally {
      await pool.close();
    }
  },
);

test(
  'transaction and savepoint handles obey exact scope ownership and cleanup on success and rollback',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const parent = await client.prepare('SELECT 1 AS n');
      let transactionStatement: PreparedStatement | undefined;
      await client.transaction(async (tx) => {
        await assert.rejects(parent.query(), { code: 'PGCLEAR_BUSY' });
        await assert.rejects(parent.close(), { code: 'PGCLEAR_BUSY' });
        transactionStatement = await tx.prepare('SELECT 2 AS n');
        for (const fail of [false, true]) {
          let childStatement: PreparedStatement | undefined;
          const work = tx.savepoint(async (child) => {
            await assert.rejects(transactionStatement!.query(), { code: 'PGCLEAR_BUSY' });
            childStatement = await child.prepare('SELECT $1::integer AS n');
            assert.deepEqual((await childStatement.query([3])).rows, [{ n: 3 }]);
            if (fail) await child.queryClassic('SELECT 1/0', []);
          });
          if (fail) await assert.rejects(work, { code: '22012' });
          else await work;
          await assert.rejects(childStatement!.query([3]), { code: 'PGCLEAR_EXPIRED' });
          assert.equal((await tx.queryClassic(countSql, [])).rows[0]!.n, '2');
        }
        assert.deepEqual((await transactionStatement.query()).rows, [{ n: 2 }]);
      });
      await assert.rejects(transactionStatement!.query(), { code: 'PGCLEAR_EXPIRED' });
      assert.equal((await client.queryClassic(countSql, [])).rows[0]!.n, '1');
      assert.deepEqual((await parent.query()).rows, [{ n: 1 }]);
      await assert.rejects(
        client.transaction(async (tx) => {
          await tx.prepare('SELECT 4');
          await assert.rejects(tx.prepare('SELECT FROM'), { code: '42601' });
          await tx.queryClassic('SELECT 1', []);
        }),
        { code: '25P02' },
      );
      assert.equal((await client.queryClassic(countSql, [])).rows[0]!.n, '1');
      await parent.close();
    } finally {
      await client.close();
    }
  },
);

test('schema invalidation surfaces once without retrying a prepared write', within, async () => {
  const { client } = await testConnection();
  try {
    await client.queryClassic('CREATE TEMP TABLE prepared_schema (n integer)', []);
    const prepared = await client.prepare('INSERT INTO prepared_schema VALUES ($1) RETURNING *');
    await prepared.query([1]);
    await client.queryClassic('ALTER TABLE prepared_schema ADD COLUMN label text', []);
    await assert.rejects(prepared.query([2]), { code: '0A000' });
    assert.deepEqual((await client.queryClassic('SELECT n FROM prepared_schema', [])).rows, [
      { n: 1 },
    ]);
    await prepared.close();
    const removed = await client.prepare('SELECT 1');
    await client.queryClassic('DEALLOCATE ALL', []);
    await assert.rejects(removed.query(), { code: '26000' });
    await removed.close();
  } finally {
    await client.close();
  }
});

test(
  'queued prepared deadlines/abort leave the statement usable and remove listeners',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const prepared = await client.prepare('SELECT $1::integer AS n');
      const blocking = client.queryClassic('SELECT pg_sleep(0.1)', []);
      const controller = new AbortController();
      const aborted = assert.rejects(prepared.query([1], { signal: controller.signal }), {
        code: 'PGCLEAR_ABORTED',
        outcome: 'not-sent',
      });
      controller.abort();
      const timed = assert.rejects(prepared.query([2], { timeoutMs: 1 }), {
        code: 'PGCLEAR_TIMEOUT',
        outcome: 'not-sent',
      });
      await Promise.all([blocking, aborted, timed]);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.deepEqual((await prepared.query([3])).rows, [{ n: 3 }]);
      await prepared.close();
    } finally {
      await client.close();
    }
  },
);

for (const mode of ['abort', 'timeout'] as const)
  test(`active prepared ${mode} retires the owning session`, within, async () => {
    const { client } = await testConnection();
    try {
      const prepared = await client.prepare('SELECT pg_sleep(30)');
      const controller = new AbortController();
      const pending = assert.rejects(
        prepared.query([], mode === 'abort' ? { signal: controller.signal } : { timeoutMs: 20 }),
        { code: mode === 'abort' ? 'PGCLEAR_ABORTED' : 'PGCLEAR_TIMEOUT', outcome: 'confirmed' },
      );
      if (mode === 'abort') controller.abort();
      await pending;
      await assert.rejects(prepared.query(), { code: 'PGCLEAR_CLOSED' });
      await prepared.close();
    } finally {
      await client.close();
    }
  });

test(
  'prepared slow encoders obey dispatch deadlines without disposing the confirmed name',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.queryClassic('CREATE TEMP TABLE prepared_deadline (label text)', []);
      const prepared = await client.prepare('INSERT INTO prepared_deadline VALUES ($1)');
      const codec: Codec<string> = {
        oid: 25,
        text: {
          encode(value) {
            const end = performance.now() + 10;
            while (performance.now() < end) {}
            return value;
          },
          decode: String,
        },
      };
      await assert.rejects(prepared.query([param('too late', codec)], { timeoutMs: 1 }), {
        code: 'PGCLEAR_TIMEOUT',
        outcome: 'not-sent',
      });
      await prepared.query(['valid']);
      assert.deepEqual(
        (await client.queryClassic('SELECT label FROM prepared_deadline', [])).rows,
        [{ label: 'valid' }],
      );
      await prepared.close();
    } finally {
      await client.close();
    }
  },
);

test(
  'server disconnect expires a confirmed prepared handle without reconnecting it',
  within,
  async () => {
    const { client, applicationName } = await testConnection();
    const { client: admin } = await testConnection();
    try {
      const prepared = await client.prepare('SELECT pg_sleep(30)');
      const pending = assert.rejects(prepared.query(), { code: '57P01' });
      await admin.queryClassic(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND application_name=$2',
        [client.info.backendPid, applicationName],
      );
      await pending;
      await client.close();
      await assert.rejects(prepared.query(), { code: 'PGCLEAR_CLOSED' });
      await prepared.close();
    } finally {
      await Promise.all([client.close(), admin.close()]);
    }
  },
);
