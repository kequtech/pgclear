import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  builtin,
  createPool,
  defaultCodecs,
  param,
  sql,
  type Executor,
  type Lease,
} from '../../src/index.js';
import { databaseUrl, testConnection } from '../helpers/database.js';

const selected = defaultCodecs.with({
  oid: 23,
  text: {
    encode: () => {
      throw Error('Result codec must not select parameter encoding.');
    },
    decode: (value: string) => 'n:' + value,
    typescript: 'string',
  },
});

test('result registries are isolated per queued operation and leave the selected registry immutable', async () => {
  const { client } = await testConnection({ codecs: selected });
  try {
    assert.equal(client.codecs, selected);
    assert.ok(Object.isFrozen(client.codecs));
    const results = await Promise.all([
      client.queryClassic('SELECT $1::integer AS value', [1]),
      client.queryClassic('SELECT $1::integer AS value', [2], { codecs: defaultCodecs }),
      client.query(sql`SELECT ${3}::integer AS value`, { codecs: defaultCodecs }),
      client.queryClassic('SELECT $1::integer AS value', [4], {
        codecs: selected,
        rowMode: 'array',
      }),
      client.queryClassic('SELECT $1::integer AS value', [5]),
    ]);
    assert.deepEqual(
      results.map((result) => result.rows),
      [[{ value: 'n:1' }], [{ value: 2 }], [{ value: 3 }], [['n:4']], [{ value: 'n:5' }]],
    );
    assert.equal(client.codecs, selected);
    assert.equal(client.codecs.typescript(23), 'string');
    const input = {
      oid: 23,
      text: { encode: (value: number) => String(value * 10), decode: Number },
    };
    assert.deepEqual(
      (
        await client.queryClassic('SELECT $1 AS value', [param(3, input)], {
          codecs: defaultCodecs,
        })
      ).rows,
      [{ value: 30 }],
    );
    assert.deepEqual((await client.queryClassic('SELECT $1 AS value', [param(3, input)])).rows, [
      { value: 'n:30' },
    ]);
  } finally {
    await client.close();
  }
});

test('pool, borrowed leases, transactions and savepoints expose the same registry without replacing the session', async () => {
  const pool = createPool({ connectionString: databaseUrl(), codecs: selected, maxConnections: 1 });
  assert.equal(pool.codecs, selected);
  assert.equal(pool.stats.total, 0);
  let lease: Lease | undefined;
  async function check(executor: Executor) {
    assert.equal(executor.codecs, selected);
    assert.deepEqual(
      (await executor.queryClassic('SELECT 42 AS value', undefined, { codecs: defaultCodecs }))
        .rows,
      [{ value: 42 }],
    );
    assert.deepEqual((await executor.queryClassic('SELECT 43 AS value')).rows, [{ value: 'n:43' }]);
  }
  try {
    const options = { codecs: defaultCodecs };
    const pending = pool.queryClassic('SELECT 41 AS value', [], options);
    options.codecs = selected;
    assert.deepEqual((await pending).rows, [{ value: 41 }]);
    await check(pool);
    lease = await pool.acquire();
    const pid = lease.info.backendPid;
    await lease.queryClassic('CREATE TEMP TABLE operation_codec_borrowed(value integer)');
    await lease.queryClassic('INSERT INTO operation_codec_borrowed VALUES(7)');
    await lease.transaction(async (tx) => {
      await check(tx);
      assert.equal(tx.info.backendPid, pid);
      await tx.queryClassic("SET LOCAL application_name='operation_codec_borrowed'");
      await tx.savepoint(async (sp) => {
        await check(sp);
        const result = await sp.queryClassic(
          "SELECT value,pg_backend_pid() AS pid,current_setting('application_name') AS app FROM operation_codec_borrowed",
          [],
          { codecs: defaultCodecs },
        );
        assert.deepEqual(result.rows, [{ value: 7, pid, app: 'operation_codec_borrowed' }]);
        assert.equal(pool.stats.total, 1);
      });
    });
    await check(lease);
    await lease.release();
    await assert.rejects(lease.queryClassic('SELECT 1', [], { codecs: defaultCodecs }), {
      code: 'PGCLEAR_EXPIRED',
      outcome: 'not-sent',
    });
    assert.equal(lease.codecs, selected);
    await check(pool);
  } finally {
    await lease?.release();
    await pool.close();
  }
});

test('prepared and streamed operations use explicit result registries without changing defaults', async () => {
  const { client } = await testConnection({ codecs: selected });
  try {
    const prepared = await client.prepare('SELECT $1::integer AS value');
    try {
      assert.deepEqual((await prepared.query([1], { codecs: defaultCodecs })).rows, [{ value: 1 }]);
      await assert.rejects(prepared.query([1], { codecs: {} as never, timeoutMs: 3600000 }), {
        code: 'PGCLEAR_CONFIGURATION',
      });
      assert.deepEqual((await prepared.query([2])).rows, [{ value: 'n:2' }]);
    } finally {
      await prepared.close();
    }
    const rows = [];
    for await (const row of client.stream('SELECT generate_series(1,5) AS value', {
      codecs: defaultCodecs,
      batchSize: 2,
      rowMode: 'array',
    }))
      rows.push(row);
    assert.deepEqual(rows, [[1], [2], [3], [4], [5]]);
    const invalid = client.stream('SELECT 1', { codecs: {} as never, timeoutMs: 3600000 });
    await Promise.all([
      assert.rejects(invalid.fields, { code: 'PGCLEAR_CONFIGURATION' }),
      assert.rejects(invalid.completion, { code: 'PGCLEAR_CONFIGURATION' }),
    ]);
    assert.equal(client.codecs, selected);
    assert.deepEqual((await client.queryClassic('SELECT 6 AS value')).rows, [{ value: 'n:6' }]);
  } finally {
    await client.close();
  }
});

test('invalid registries reject before encoding and decoder failures drain only their own operation', async () => {
  const { client } = await testConnection({ codecs: selected });
  try {
    let encoded = 0;
    const input = param(1, {
      ...builtin.int4,
      text: {
        encode: (value: number) => {
          encoded++;
          return String(value);
        },
        decode: Number,
      },
    });
    await assert.rejects(
      client.queryClassic('SELECT $1', [input], { codecs: {} as never, timeoutMs: 3600000 }),
      { code: 'PGCLEAR_CONFIGURATION', outcome: 'not-sent' },
    );
    assert.equal(encoded, 0);
    const failing = defaultCodecs.with({
      oid: 23,
      text: {
        encode: String,
        decode: (value: string) => {
          if (value === '2') throw Error('decoder fixture');
          return Number(value);
        },
        typescript: 'number',
      },
    });
    const results = await Promise.allSettled([
      client.queryClassic('SELECT generate_series(1,3) AS value', [], { codecs: failing }),
      client.queryClassic('SELECT 4 AS value', [], { codecs: defaultCodecs }),
      client.queryClassic('SELECT 5 AS value'),
    ]);
    assert.equal(results[0]!.status, 'rejected');
    if (results[0]!.status === 'rejected') assert.equal(results[0]!.reason.code, 'PGCLEAR_DECODE');
    if (results[1]!.status === 'fulfilled')
      assert.deepEqual(results[1]!.value.rows, [{ value: 4 }]);
    else assert.fail();
    if (results[2]!.status === 'fulfilled')
      assert.deepEqual(results[2]!.value.rows, [{ value: 'n:5' }]);
    else assert.fail();
    await assert.rejects(client.script('SELECT 1', { codecs: defaultCodecs } as never), {
      code: 'PGCLEAR_CONFIGURATION',
    });
    assert.equal(client.codecs, selected);
  } finally {
    await client.close();
  }
});
