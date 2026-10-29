import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testConnection } from '../helpers/database.js';

const within = { timeout: 10000 };
test(
  'Describe returns type/origin metadata on the same session and never executes the SQL',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.script(
        'CREATE TEMP TABLE described (id integer NOT NULL, exact numeric); CREATE TEMP SEQUENCE describe_counter',
      );
      const description = await client.describe({
        text: 'SELECT id, exact FROM described WHERE id=$1 AND exact>$2',
        parameterTypes: [23, 1700],
      });
      assert.deepEqual(description.parameterTypes, [23, 1700]);
      assert.deepEqual(
        description.fields.map((f) => f.dataTypeOid),
        [23, 1700],
      );
      assert.ok(description.fields[0]!.tableOid > 0);
      assert.equal(description.fields[1]!.columnAttribute, 2);
      assert.ok(Object.isFrozen(description));
      assert.ok(Object.isFrozen(description.parameterTypes));
      assert.equal(
        (await client.describe("SELECT nextval('describe_counter') AS value")).fields[0]!
          .dataTypeOid,
        20,
      );
      assert.equal(
        (await client.queryClassic('SELECT is_called FROM describe_counter', [])).rows[0]!
          .is_called,
        false,
      );
      assert.deepEqual(await client.describe('BEGIN'), { parameterTypes: [], fields: [] });
      assert.equal(client.transactionStatus, 'idle');
      await assert.rejects(client.describe('SELECT FROM'), { code: '42601' });
      await assert.rejects(client.describe({ text: 'SELECT $1', values: [1] } as never), {
        code: 'PGCLEAR_ENCODE',
        outcome: 'not-sent',
      });
      await client.queryClassic('BEGIN', []);
      assert.equal((await client.describe('SELECT id FROM described')).fields[0]!.dataTypeOid, 23);
      assert.equal(client.transactionStatus, 'transaction');
      await client.queryClassic('ROLLBACK', []);
      assert.equal((await client.queryClassic('SELECT 4 AS n', [])).rows[0]!.n, 4);
    } finally {
      await client.close();
    }
  },
);

test(
  'scripts return ordered independent result sets and leave subsequent operations usable',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const results = await client.script(
        'CREATE TEMP TABLE scripted (n integer); INSERT INTO scripted VALUES(1),(2); SELECT n FROM scripted ORDER BY n; SELECT true AS flag',
      );
      assert.deepEqual(
        results.map((r) => [r.command, r.rowCount]),
        [
          ['CREATE', null],
          ['INSERT', 2n],
          ['SELECT', 2n],
          ['SELECT', 1n],
        ],
      );
      assert.deepEqual(results[2]!.rows, [{ n: 1 }, { n: 2 }]);
      assert.deepEqual(results[3]!.rows, [{ flag: true }]);
      assert.ok(Object.isFrozen(results));
      assert.ok(Object.isFrozen(results[2]!.fields));
      assert.equal((await client.script(''))[0]!.commandTag, '');
      assert.equal(
        (await client.queryClassic('SELECT count(*) AS n FROM scripted', [])).rows[0]!.n,
        2n,
      );
      await assert.rejects(client.script('SELECT 1 AS n, 2 AS n; SELECT 3'), {
        code: 'PGCLEAR_DECODE',
      });
      assert.equal((await client.queryClassic('SELECT 4 AS n', [])).rows[0]!.n, 4);
    } finally {
      await client.close();
    }
  },
);

test(
  'script errors preserve PostgreSQL implicit and explicit commit semantics',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.queryClassic('CREATE TEMP TABLE script_effects (n integer)', []);
      await assert.rejects(client.script('INSERT INTO script_effects VALUES(1); SELECT 1/0'), {
        code: '22012',
      });
      assert.equal(
        (await client.queryClassic('SELECT count(*) AS n FROM script_effects', [])).rows[0]!.n,
        0n,
      );
      await assert.rejects(
        client.script('BEGIN; INSERT INTO script_effects VALUES(2); COMMIT; SELECT 1/0'),
        { code: '22012' },
      );
      assert.deepEqual((await client.queryClassic('SELECT n FROM script_effects', [])).rows, [
        { n: 2 },
      ]);
      assert.equal(client.transactionStatus, 'idle');
    } finally {
      await client.close();
    }
  },
);

test(
  'metadata and zero-row script results consume the buffered result budget',
  within,
  async () => {
    for (const work of ['describe', 'script'] as const) {
      const { client } = await testConnection({ maxResultBytes: 128 });
      try {
        const promise =
          work === 'describe'
            ? client.describe('SELECT 1 AS "' + 'x'.repeat(60) + '", 2 AS "' + 'y'.repeat(60) + '"')
            : client.script(Array(32).fill('DO $$BEGIN END$$').join(';'));
        await assert.rejects(promise, { code: 'PGCLEAR_RESULT_LIMIT' });
      } finally {
        await client.close();
      }
    }
  },
);
