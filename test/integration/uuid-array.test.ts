import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtin, DatabaseError, param, type PgArray } from '../../src/index.js';
import { testConnection } from '../helpers/database.js';

const within = { timeout: 10000 };
const first = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const second = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

test(
  'UUID arrays infer their parameter type without SQL casts and preserve shape and SQL NULL',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      for (const ids of [
        null,
        [],
        [first, null, second],
        [
          [first, null],
          [second, first],
        ],
      ] satisfies (PgArray<string> | null)[]) {
        const result = await client.queryClassic<{ ids: PgArray<string> | null; type: string }>(
          'SELECT $1 AS ids, pg_typeof($1)::text AS type',
          [param(ids, builtin.uuidArray)],
        );
        assert.equal(result.fields[0]!.dataTypeOid, 2951);
        assert.deepEqual(result.rows, [{ ids, type: 'uuid[]' }]);
      }
      const result = await client.queryClassic('SELECT $1::uuid = ANY($2) AS matched', [
        first,
        param([second, first], builtin.uuidArray),
      ]);
      assert.deepEqual(result.rows, [{ matched: true }]);
    } finally {
      await client.close();
    }
  },
);

test('text arrays need an SQL cast when used as UUID arrays', within, async () => {
  const { client } = await testConnection();
  try {
    const text = await client.queryClassic('SELECT $1 AS ids, pg_typeof($1)::text AS type', [
      param([first, null], builtin.textArray),
    ]);
    assert.equal(text.fields[0]!.dataTypeOid, 1009);
    assert.deepEqual(text.rows, [{ ids: [first, null], type: 'text[]' }]);
    const converted = await client.queryClassic(
      'SELECT $1::uuid[] AS ids, pg_typeof($1)::text AS type',
      [param([first, null], builtin.textArray)],
    );
    assert.equal(converted.fields[0]!.dataTypeOid, 2951);
    assert.deepEqual(converted.rows, [{ ids: [first, null], type: 'text[]' }]);
  } finally {
    await client.close();
  }
});

test(
  'PostgreSQL normalizes valid UUID spellings and rejects invalid UUID syntax',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const result = await client.queryClassic('SELECT $1 AS ids', [
        param([first.replaceAll('-', '').toUpperCase(), '{' + second + '}'], builtin.uuidArray),
      ]);
      assert.deepEqual(result.rows, [{ ids: [first, second] }]);
      await assert.rejects(
        client.queryClassic('SELECT $1 AS ids', [param(['not-a-uuid'], builtin.uuidArray)]),
        (error: unknown) => error instanceof DatabaseError && error.code === '22P02',
      );
      await assert.rejects(
        client.queryClassic('SELECT $1 AS ids', [param(['a\0b'], builtin.uuidArray)]),
        { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' },
      );
      assert.deepEqual((await client.queryClassic('SELECT 1 AS value')).rows, [{ value: 1 }]);
    } finally {
      await client.close();
    }
  },
);
