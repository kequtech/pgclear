import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtin, defaultCodecs, json, param, type Codec } from '../../src/index.js';
import { testConnection } from '../helpers/database.js';

const within = { timeout: 10000 };

test(
  'built-in arrays preserve nested values, exact decimals, bounds and non-comma delimiters',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const result = await client.queryClassic(
        `SELECT ARRAY[9007199254740993.25,NULL]::numeric[] AS decimals,
      ARRAY[9007199254740993,NULL]::bigint[] AS bigs,
      '[0:1][-2:-1]={{1,NULL},{2,3}}'::integer[] AS nested,
      ARRAY['NULL',NULL,'','a,b','a"b','a\\b']::text[] AS texts,
      ARRAY[box(point(1,1),point(0,0)),NULL] AS boxes,
      ARRAY[true,NULL,false] AS flags, ARRAY['infinity'::date,NULL] AS dates`,
        [],
      );
      assert.deepEqual(result.rows, [
        {
          decimals: ['9007199254740993.25', null],
          bigs: [9007199254740993n, null],
          nested: [
            [1, null],
            [2, 3],
          ],
          texts: ['NULL', null, '', 'a,b', 'a"b', 'a\\b'],
          boxes: ['(1,1),(0,0)', null],
          flags: [true, null, false],
          dates: ['infinity', null],
        },
      ]);
      assert.deepEqual(
        (
          await client.queryClassic('SELECT $1::numeric[] AS a, $2::text[] AS b', [
            param(['9007199254740993.25', null], builtin.numericArray),
            param(['NULL', null, 'a,b', 'a\\"b'], builtin.textArray),
          ])
        ).rows,
        [{ a: ['9007199254740993.25', null], b: ['NULL', null, 'a,b', 'a\\"b'] }],
      );
      assert.deepEqual(
        (
          await client.queryClassic('SELECT $1 AS nested', [
            param(
              [
                [1, null],
                [2, 3],
              ],
              builtin.int4Array,
            ),
          ])
        ).rows,
        [
          {
            nested: [
              [1, null],
              [2, 3],
            ],
          },
        ],
      );
    } finally {
      await client.close();
    }
  },
);

test(
  'scalar overrides derive arrays; explicit array overrides win without mutating another connection',
  within,
  async () => {
    const scalar: Codec<string> = {
      oid: 23,
      text: { encode: (value) => value, decode: (value) => 'int:' + value },
    };
    const array: Codec<string> = {
      oid: 1007,
      text: { encode: (value) => value, decode: (value) => 'raw:' + value },
    };
    const { client: ordinary } = await testConnection();
    try {
      for (const [codecs, expected] of [
        [defaultCodecs.with(scalar), ['int:1', null, 'int:2']],
        [defaultCodecs.with(array).with(scalar), 'raw:{1,NULL,2}'],
        [defaultCodecs.with(scalar).with(array), 'raw:{1,NULL,2}'],
      ] as const) {
        const { client } = await testConnection({ codecs });
        try {
          const row = (
            await client.queryClassic('SELECT 1::int AS n, ARRAY[1,NULL,2]::int[] AS a', [])
          ).rows[0]!;
          assert.equal(row.n, 'int:1');
          assert.deepEqual(row.a, expected);
        } finally {
          await client.close();
        }
      }
      assert.deepEqual(
        (await ordinary.queryClassic('SELECT 1 AS n, ARRAY[1,NULL]::int[] AS a', [])).rows,
        [{ n: 1, a: [1, null] }],
      );
    } finally {
      await ordinary.close();
    }
  },
);

test(
  'SQL NULL, typed SQL NULL, JSON null and every JSON value shape have explicit encodings',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const row = (
        await client.queryClassic(
          `SELECT $1::jsonb IS NULL AS sql_null,
      $2::jsonb IS NULL AS typed_null, $3::jsonb IS NULL AS json_is_sql_null,
      jsonb_typeof($3::jsonb) AS json_kind, $4::jsonb AS string, $5::json AS array,
      $6::jsonb AS object, $7::jsonb AS number, $8::jsonb AS boolean`,
          [
            null,
            param(null, builtin.jsonb),
            json(null),
            json('text'),
            json([1, null], 'json'),
            json({ ok: true }),
            json(42),
            json(false),
          ],
        )
      ).rows[0];
      assert.deepEqual(row, {
        sql_null: true,
        typed_null: true,
        json_is_sql_null: false,
        json_kind: 'null',
        string: 'text',
        array: [1, null],
        object: { ok: true },
        number: 42,
        boolean: false,
      });
      const results = await Promise.allSettled([
        client.queryClassic('SELECT $1::jsonb AS value', [json({ tag: 'first' })]),
        client.queryClassic('SELECT $1::jsonb AS value', [json({ bad: 1n })]),
        client.queryClassic('SELECT $1::jsonb AS value', [json({ tag: 'third' })]),
      ]);
      assert.equal(results[1]!.status, 'rejected');
      if (results[1]!.status === 'rejected')
        assert.equal(results[1]!.reason.code, 'PGCLEAR_ENCODE');
      if (results[0]!.status === 'fulfilled')
        assert.deepEqual(results[0]!.value.rows, [{ value: { tag: 'first' } }]);
      else assert.fail();
      if (results[2]!.status === 'fulfilled')
        assert.deepEqual(results[2]!.value.rows, [{ value: { tag: 'third' } }]);
      else assert.fail();
    } finally {
      await client.close();
    }
  },
);

test(
  'raw JSON codecs preserve numeric tokens and distinguish JSON null from SQL NULL',
  within,
  async () => {
    const { client } = await testConnection({
      codecs: defaultCodecs.with(builtin.jsonText).with(builtin.jsonbText),
    });
    try {
      const row = (
        await client.queryClassic(
          'SELECT $1::json AS exact, $2::jsonb AS value, NULL::jsonb AS missing, $3::jsonb AS token, ARRAY[$2::jsonb,NULL] AS array',
          [
            param('{"n":9007199254740993}', builtin.jsonText),
            json(null),
            param('null', builtin.jsonbText),
          ],
        )
      ).rows[0]!;
      assert.equal(row.exact, '{"n":9007199254740993}');
      assert.equal(row.value, 'null');
      assert.equal(row.missing, null);
      assert.equal(row.token, 'null');
      assert.deepEqual(row.array, ['null', null]);
    } finally {
      await client.close();
    }
  },
);

test(
  'binary parameter encoding is explicit and results own their byte storage',
  within,
  async () => {
    const integer: Codec<number> = {
      oid: 23,
      binary: {
        encode: (value) => {
          const bytes = Buffer.alloc(4);
          bytes.writeInt32BE(value);
          return bytes;
        },
        decode: (value) => Buffer.from(value).readInt32BE(),
      },
    };
    const { client } = await testConnection();
    try {
      const bytes = new Uint8Array([0, 255, 92]);
      const pending = client.queryClassic('SELECT $1 AS n, $2 AS bytes', [
        param(42, integer),
        param(bytes, builtin.bytea, 'binary'),
      ]);
      bytes.fill(1);
      assert.deepEqual((await pending).rows, [{ n: 42, bytes: new Uint8Array([0, 255, 92]) }]);
      const prepared = await client.prepare({ text: 'SELECT $1', parameterTypes: [25] });
      try {
        await assert.rejects(prepared.query([param(1, integer)]), {
          code: 'PGCLEAR_ENCODE',
          outcome: 'not-sent',
        });
      } finally {
        await prepared.close();
      }
    } finally {
      await client.close();
    }
  },
);

test(
  'decoder failure drains to ReadyForQuery and keeps later results with their owner',
  within,
  async () => {
    const { client } = await testConnection({
      codecs: defaultCodecs.with({
        oid: 23,
        text: {
          encode: String,
          decode: (value) => {
            if (value === '2') throw Error('fixture');
            return Number(value);
          },
        },
      }),
    });
    try {
      const outcomes = await Promise.allSettled([
        client.queryClassic('SELECT 1 AS n', []),
        client.queryClassic('SELECT generate_series(1,3) AS n', []),
        client.queryClassic('SELECT 3 AS n', []),
      ]);
      assert.equal(outcomes[1]!.status, 'rejected');
      if (outcomes[1]!.status === 'rejected')
        assert.equal(outcomes[1]!.reason.outcome, 'confirmed');
      if (outcomes[0]!.status === 'fulfilled')
        assert.deepEqual(outcomes[0]!.value.rows, [{ n: 1 }]);
      else assert.fail();
      if (outcomes[2]!.status === 'fulfilled')
        assert.deepEqual(outcomes[2]!.value.rows, [{ n: 3 }]);
      else assert.fail();
      await assert.rejects(client.script('SELECT 1; SELECT 2; SELECT 3'), {
        code: 'PGCLEAR_DECODE',
        outcome: 'confirmed',
      });
      await assert.rejects(client.script('SELECT 2; SELECT 1/0'), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors.map((error) => error.code),
          ['PGCLEAR_DECODE', '22012'],
        );
        assert.equal(error.errors[0].outcome, 'confirmed');
        return true;
      });
      assert.equal((await client.queryClassic('SELECT 3 AS n', [])).rows[0]!.n, 3);
    } finally {
      await client.close();
    }
  },
);

test(
  'reentrant and expired encoders cannot reorder operations or dispatch after a deadline',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.queryClassic('CREATE TEMP TABLE encoder_order (id serial, label text)', []);
      let nested: Promise<unknown> | undefined;
      const reentrant: Codec<string> = {
        oid: 25,
        text: {
          encode: (value) => {
            nested = client.queryClassic("INSERT INTO encoder_order(label) VALUES ('second')", []);
            return value;
          },
          decode: (value) => value,
        },
      };
      await client.queryClassic('INSERT INTO encoder_order(label) VALUES ($1)', [
        param('first', reentrant),
      ]);
      await nested;
      assert.deepEqual(
        (await client.queryClassic('SELECT label FROM encoder_order ORDER BY id', [])).rows,
        [{ label: 'first' }, { label: 'second' }],
      );
      const slow: Codec<string> = {
        oid: 25,
        text: {
          encode: (value) => {
            const end = performance.now() + 10;
            while (performance.now() < end) {}
            return value;
          },
          decode: (value) => value,
        },
      };
      await assert.rejects(
        client.queryClassic(
          'INSERT INTO encoder_order(label) VALUES($1)',
          [param('expired', slow)],
          { timeoutMs: 1 },
        ),
        { code: 'PGCLEAR_TIMEOUT', outcome: 'not-sent' },
      );
      assert.equal(
        (await client.queryClassic('SELECT count(*) AS n FROM encoder_order', [])).rows[0]!.n,
        2n,
      );
    } finally {
      await client.close();
    }
  },
);

test(
  'custom int8 representation preserves precision while command counts stay bigint',
  within,
  async () => {
    const int8AsText: Codec<string> = { ...builtin.text, oid: builtin.int8.oid };
    const codecs = defaultCodecs.with(int8AsText);
    const { client } = await testConnection({ codecs });
    try {
      const maximum = '9223372036854775807';
      const result = await client.queryClassic('SELECT $1 AS id, ARRAY[$1,NULL] AS ids', [
        param(maximum, int8AsText),
      ]);
      assert.deepEqual(result.rows, [{ id: maximum, ids: [maximum, null] }]);
      assert.equal(result.rowCount, 1n);
      assert.throws(() => JSON.stringify(result), TypeError);
      const body = JSON.stringify(result, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      const response = JSON.parse(body);
      assert.deepEqual(response.rows, result.rows);
      assert.equal(response.rowCount, '1');
      assert.equal(codecs.typescript(20), 'string');
      assert.equal(codecs.typescript(1016), 'PgArray<string>');
      assert.equal(defaultCodecs.typescript(20), 'bigint');
    } finally {
      await client.close();
    }
  },
);
