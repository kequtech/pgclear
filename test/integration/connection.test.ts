import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect, DatabaseError, DriverError } from '../../src/index.js';
import { databaseUrl, ownedName, testConnection } from '../helpers/database.js';
import { passwords } from '../helpers/passwords.js';

const run = promisify(execFile);
const within = { timeout: 10000 };

test(
  'real scalar parameters, NULL, metadata and loss-conscious results round trip',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const result = await client.queryClassic(
        `SELECT $1::int2 AS small, $2::int4 AS integer, $3::int8 AS big,
        $4::float8 AS ratio, $5::bool AS yes, $6::text AS text, $7::bytea AS bytes,
        $8::text AS missing, $9::numeric AS exact, $10::date AS day, $11::jsonb AS json`,
        [
          2,
          42,
          '9007199254740993',
          1.5,
          true,
          'héllo',
          new Uint8Array([0, 255]),
          null,
          '12345678901234567890.1234',
          '2026-10-28',
          '{"ok":true}',
        ],
      );
      assert.equal(result.rowCount, 1);
      assert.equal(result.command, 'SELECT');
      assert.deepEqual(result.rows, [
        {
          small: 2,
          integer: 42,
          big: '9007199254740993',
          ratio: 1.5,
          yes: true,
          text: 'héllo',
          bytes: new Uint8Array([0, 255]),
          missing: null,
          exact: '12345678901234567890.1234',
          day: '2026-10-28',
          json: { ok: true },
        },
      ]);
      assert.deepEqual(
        result.fields.map((field) => field.dataTypeOid),
        [21, 23, 20, 701, 16, 25, 17, 25, 1700, 1082, 3802],
      );
      assert.ok(Object.isFrozen(result.fields));
      assert.ok(Object.isFrozen(result.fields[0]));
      assert.equal((await client.queryClassic('', [])).commandTag, '');
    } finally {
      await client.close();
    }
  },
);

test(
  'real errors and serialization failures retain request ownership and permit subsequent queries',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const results = await Promise.allSettled([
        client.queryClassic('SELECT 1 AS value', []),
        client.queryClassic('SELECT 1 / 0', []),
        client.query({ text: 'SELECT $1', values: [undefined] } as never),
        client.queryClassic('SELECT 3 AS value', []),
      ]);
      assert.equal(results[0]!.status, 'fulfilled');
      assert.equal(results[3]!.status, 'fulfilled');
      if (results[0]!.status === 'fulfilled')
        assert.deepEqual(results[0]!.value.rows, [{ value: 1 }]);
      if (results[3]!.status === 'fulfilled')
        assert.deepEqual(results[3]!.value.rows, [{ value: 3 }]);
      assert.equal(results[1]!.status, 'rejected');
      assert.equal(results[2]!.status, 'rejected');
      if (results[1]!.status === 'rejected') {
        assert.ok(results[1]!.reason instanceof DatabaseError);
        assert.equal(results[1]!.reason.code, '22012');
      }
      if (results[2]!.status === 'rejected') assert.equal(results[2]!.reason.outcome, 'not-sent');
      await assert.rejects(client.queryClassic('SELECT 1; SELECT 2', []), { code: '42601' });
      assert.equal((await client.queryClassic('SELECT 4 AS value', [])).rows[0]!.value, 4);
    } finally {
      await client.close();
    }
  },
);

test(
  'object rows safely preserve special keys; array mode handles duplicate names',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const special = (
        await client.queryClassic(
          'SELECT 42 AS "__proto__", 7 AS constructor, NULL AS "toString"',
          [],
        )
      ).rows[0]!;
      assert.equal(Object.getPrototypeOf(special), Object.prototype);
      assert.ok(Object.hasOwn(special, '__proto__'));
      assert.equal(special.__proto__, 42);
      for (const [name, value] of [
        ['__proto__', 42],
        ['constructor', 7],
        ['toString', null],
      ] as const) {
        assert.deepEqual(Object.getOwnPropertyDescriptor(special, name), {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      await assert.rejects(client.queryClassic('SELECT 1 AS n, 2 AS n', []), {
        code: 'PGCLEAR_DECODE',
        outcome: 'confirmed',
      });
      assert.deepEqual(
        (await client.queryClassic('SELECT 1 AS n, 2 AS n', [], { rowMode: 'array' })).rows,
        [[1, 2]],
      );
    } finally {
      await client.close();
    }
  },
);

test(
  'owned schema workflow preserves field origins, affected counts and server transaction status',
  within,
  async () => {
    const { client } = await testConnection(),
      schema = ownedName();
    try {
      await client.queryClassic(`CREATE SCHEMA "${schema}"`, []);
      await client.queryClassic(`CREATE TABLE "${schema}".items (id integer PRIMARY KEY)`, []);
      assert.equal(
        (await client.queryClassic(`INSERT INTO "${schema}".items VALUES (1), (2)`, [])).rowCount,
        2,
      );
      const result = await client.queryClassic(`SELECT id FROM "${schema}".items ORDER BY id`, []);
      assert.ok(result.fields[0]!.tableOid > 0);
      assert.equal(result.fields[0]!.columnAttribute, 1);
      await client.queryClassic('BEGIN', []);
      assert.equal(client.transactionStatus, 'transaction');
      await assert.rejects(client.queryClassic('SELECT 1 / 0', []), { code: '22012' });
      assert.equal(client.transactionStatus, 'failed');
      await client.queryClassic('ROLLBACK', []);
      assert.equal(client.transactionStatus, 'idle');
    } finally {
      await client.queryClassic('ROLLBACK', []);
      await client.queryClassic(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []);
      await client.close();
    }
  },
);

test(
  'backend loss rejects active and queued work, and never revives the connection',
  within,
  async () => {
    const { client, applicationName } = await testConnection(),
      { client: admin } = await testConnection();
    try {
      const active = client.queryClassic('SELECT pg_sleep(30)', []);
      const queued = client.queryClassic('SELECT 2', []);
      const rejectedActive = assert.rejects(active, (error) => {
        assert.ok(error instanceof DatabaseError || error instanceof DriverError);
        return true;
      });
      const rejectedQueued = assert.rejects(queued, {
        code: 'PGCLEAR_CLOSED',
        outcome: 'not-sent',
      });
      const terminated = await admin.queryClassic(
        `SELECT pg_terminate_backend(pid) AS stopped
      FROM pg_stat_activity WHERE pid=$1 AND application_name=$2`,
        [client.info.backendPid, applicationName],
      );
      assert.equal(terminated.rows[0]?.stopped, true);
      await Promise.all([rejectedActive, rejectedQueued]);
      await assert.rejects(client.queryClassic('SELECT 3', []), { code: 'PGCLEAR_CLOSED' });
    } finally {
      await client.close();
      await admin.close();
    }
  },
);

test(
  'queued operation deadlines and queue bounds do not interrupt the active query',
  within,
  async () => {
    const { client } = await testConnection({ maxQueuedOperations: 1 });
    try {
      const first = client.queryClassic('SELECT pg_sleep(0.1)', []);
      const expired = assert.rejects(client.queryClassic('SELECT 2', [], { timeoutMs: 5 }), {
        code: 'PGCLEAR_TIMEOUT',
        outcome: 'not-sent',
      });
      await assert.rejects(client.queryClassic('SELECT 3', []), { code: 'PGCLEAR_QUEUE_FULL' });
      await Promise.all([first, expired]);
      assert.equal((await client.queryClassic('SELECT 4 AS value', [])).rows[0]!.value, 4);
    } finally {
      await client.close();
    }
  },
);

test('bounded close settles work without claiming server cancellation', within, async () => {
  const { client, applicationName } = await testConnection(),
    { client: admin } = await testConnection();
  try {
    const active = assert.rejects(client.queryClassic('SELECT pg_sleep(30)', []), {
      outcome: 'unknown',
    });
    await client.close({ timeoutMs: 10 });
    await active;
    // A force-disconnected backend may still be sleeping. Cancel only this test-owned backend.
    await admin.queryClassic(
      `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE pid=$1 AND application_name=$2`,
      [client.info.backendPid, applicationName],
    );
    await assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_CLOSED' });
  } finally {
    await client.close();
    await admin.close();
  }
});

test(
  'incorrect password retains SQLSTATE rather than exposing configured credentials',
  within,
  async () => {
    await assert.rejects(
      connect({ connectionString: databaseUrl(), password: 'pgclear-intentionally-wrong' }),
      (error) => {
        assert.ok(error instanceof DatabaseError);
        assert.equal(error.code, '28P01');
        assert.ok(!JSON.stringify(error).includes('pgclear-intentionally-wrong'));
        return true;
      },
    );
  },
);

test(
  'Unicode normalization and prohibited-character fallback agree with PostgreSQL and libpq',
  { timeout: 30000 },
  async () => {
    const { client: admin } = await testConnection();
    const url = new URL(databaseUrl());
    try {
      await admin.queryClassic("SET password_encryption = 'scram-sha-256'", []);
      for (const [password] of passwords) {
        const role = ownedName();
        await admin.queryClassic(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`, []);
        try {
          const client = await connect({ connectionString: databaseUrl(), user: role, password });
          try {
            assert.equal(
              (await client.queryClassic('SELECT current_user AS name', [])).rows[0]!.name,
              role,
            );
          } finally {
            await client.close();
          }
          const psql = await run(
            'psql',
            [
              '-X',
              '-h',
              url.hostname || 'localhost',
              '-p',
              url.port || '5432',
              '-U',
              role,
              '-d',
              decodeURIComponent(url.pathname.slice(1)),
              '-Atc',
              'SELECT current_user',
            ],
            { env: { ...process.env, PGPASSWORD: password }, timeout: 5000 },
          );
          assert.equal(psql.stdout.trim(), role);
        } finally {
          await admin.queryClassic(`DROP ROLE "${role}"`, []);
        }
      }
    } finally {
      await admin.close();
    }
  },
);
