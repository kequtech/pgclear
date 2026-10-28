import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtin, createPool, json, param, sql, type QueryTuple } from '../../src/index.js';
import { databaseUrl, ownedName, testConnection } from '../helpers/database.js';

test(
  'all SQL entrypoints reject malformed text before dispatch and retain the session',
  { timeout: 10000 },
  async () => {
    const { client } = await testConnection();
    try {
      for (const bad of ['\ud800', '\udc00', '\0']) {
        const text = `SELECT '${bad}' AS value`;
        for (const run of [
          () => client.query(text),
          () => client.query([text, []]),
          () => client.query({ text }),
          () => client.queryClassic(text, []),
          () => client.describe(text),
          () => client.prepare(text),
          () => client.script(text),
        ])
          await assert.rejects(run(), { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' });
        const stream = client.stream(text);
        await Promise.all([
          assert.rejects(stream.fields, { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' }),
          assert.rejects(stream.completion, { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' }),
        ]);
        const copy = client.copyTo(text);
        await assert.rejects(copy.completion, { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' });
        let pulls = 0;
        await assert.rejects(
          client.copyFrom(text, {
            async *[Symbol.asyncIterator]() {
              pulls++;
              yield new Uint8Array([1]);
            },
          }),
          { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' },
        );
        assert.equal(pulls, 0);
      }
      assert.deepEqual((await client.query("SELECT '𐀀😀é' AS value")).rows, [{ value: '𐀀😀é' }]);
    } finally {
      await client.close();
    }
  },
);

test(
  'tagged, classic, tuple and object queries share values, codecs and result metadata',
  { timeout: 10000 },
  async () => {
    const { client } = await testConnection();
    try {
      const value = "\uFEFFé'; SELECT pg_sleep(60); --";
      const statement = sql<{ value: string; exact: readonly (string | null)[]; payload: unknown }>`
      SELECT ${value}::text AS value,
             ${param(['9007199254740993.25', null], builtin.numericArray)} AS exact,
             ${json({ unicode: '\uFEFFhello' })} AS payload
    `;
      const tagged = await client.query(statement);
      const classic = await client.queryClassic(statement[0], statement[1]);
      const tuple: QueryTuple = [statement[0], statement[1]];
      const tupleResult = await client.query(tuple);
      const object = await client.query({ text: statement[0], values: statement[1] });
      assert.deepEqual(tagged.rows, [
        {
          value,
          exact: ['9007199254740993.25', null],
          payload: { unicode: '\uFEFFhello' },
        },
      ]);
      for (const other of [classic, tupleResult, object]) assert.deepEqual(other, tagged);
      assert.deepEqual(
        (
          await client.queryClassic<readonly [number, number]>(
            'SELECT $1::integer AS n, 2 AS n',
            [1],
            {
              rowMode: 'array',
            },
          )
        ).rows,
        [[1, 2]],
      );
      assert.deepEqual(
        (await client.query(sql<readonly [number]>`SELECT ${3}::integer`, { rowMode: 'array' }))
          .rows,
        [[3]],
      );
      assert.deepEqual((await client.query(sql`SELECT 1 AS value`)).rows, [{ value: 1 }]);
    } finally {
      await client.close();
    }
  },
);

test(
  'both query entrypoints retain pool, lease, transaction and savepoint ownership',
  { timeout: 10000 },
  async () => {
    const pool = createPool({
      connectionString: databaseUrl(),
      applicationName: ownedName(),
      maxConnections: 1,
    });
    try {
      assert.deepEqual(
        (await pool.query(sql<{ value: number }>`SELECT ${1}::integer AS value`)).rows,
        [{ value: 1 }],
      );
      assert.deepEqual((await pool.queryClassic('SELECT $1::integer AS value', [2])).rows, [
        { value: 2 },
      ]);
      await pool.withSession(async (session) => {
        await session.queryClassic('CREATE TEMP TABLE query_inputs (id integer)', []);
        await session.transaction(async (tx) => {
          await tx.query(sql`INSERT INTO query_inputs VALUES (${3})`);
          await tx.savepoint(async (child) => {
            await child.queryClassic('INSERT INTO query_inputs VALUES ($1)', [4]);
          });
        });
        assert.deepEqual((await session.query(sql`SELECT id FROM query_inputs ORDER BY id`)).rows, [
          { id: 3 },
          { id: 4 },
        ]);
        await session.queryClassic('DROP TABLE query_inputs', []);
      });
      const lease = await pool.acquire();
      await lease.release();
      await assert.rejects(lease.queryClassic('SELECT $1::integer', [5]), {
        code: 'PGCLEAR_EXPIRED',
      });
      await assert.rejects(pool.queryClassic('SELECT pg_sleep($1)', [10], { timeoutMs: 0 }), {
        code: 'PGCLEAR_TIMEOUT',
        outcome: 'not-sent',
      });
      assert.deepEqual(pool.stats, { total: 1, idle: 1, leased: 0, waiting: 0 });
    } finally {
      await pool.close();
    }
  },
);

test(
  'invalid binds and tuple shapes fail before dispatch and leave the connection usable',
  { timeout: 10000 },
  async () => {
    const { client } = await testConnection();
    try {
      await client.queryClassic('CREATE TEMP TABLE query_inputs (id integer)', []);
      for (const run of [
        () => client.queryClassic('INSERT INTO query_inputs VALUES ($1)', [undefined as never]),
        () => client.query(sql`INSERT INTO query_inputs VALUES (${undefined as never})`),
        () => client.query(['INSERT INTO query_inputs VALUES (1)', undefined] as never),
        () => client.query(sql`INSERT INTO query_inputs VALUES (${sql`1` as never})`),
      ]) {
        await assert.rejects(run(), { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' });
      }
      assert.deepEqual(
        (await client.queryClassic('SELECT count(*) AS n FROM query_inputs', [])).rows,
        [{ n: 0n }],
      );
      await assert.rejects(client.queryClassic('SELECT 1', [], { wrong: true } as never), {
        code: 'PGCLEAR_CONFIGURATION',
      });
    } finally {
      await client.close();
    }
  },
);
