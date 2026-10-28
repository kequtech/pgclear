import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtin, param, sql } from '../src/index.js';
import { encodeQuery } from '../src/connection/query.js';

test('sql binds interpolations as an immutable classic query tuple without altering data', () => {
  const value = "\uFEFFé'; DROP TABLE users; --";
  const query = sql`SELECT ${value}::text AS value, ${42}::integer AS id`;
  assert.deepEqual(query, ['SELECT $1::text AS value, $2::integer AS id', [value, 42]]);
  assert.ok(Object.isFrozen(query));
  assert.ok(Object.isFrozen(query[1]));
  assert.deepEqual(encodeQuery(query), encodeQuery({ text: query[0], values: query[1] }));
  assert.deepEqual(sql`SELECT 1`, ['SELECT 1', []]);
});

test('sql defers typed encoding and treats nested queries as unsupported bind values', () => {
  let calls = 0;
  const query = sql`SELECT ${param(42, {
    ...builtin.int4,
    text: {
      encode(value: number) {
        calls++;
        return String(value);
      },
      decode: Number,
    },
  })}`;
  assert.equal(calls, 0);
  encodeQuery(query);
  assert.equal(calls, 1);
  assert.throws(() => encodeQuery(sql`SELECT ${sql`1` as never}`), { code: 'PGCLEAR_ENCODE' });
});

test('invalid template invocations and malformed classic tuples reject', () => {
  assert.throws(() => sql('SELECT 1' as never), { code: 'PGCLEAR_ENCODE' });
  const chunks = Object.assign(['SELECT ', undefined], { raw: ['SELECT ', ''] });
  assert.throws(() => sql(chunks as never, 1), { code: 'PGCLEAR_ENCODE' });
  for (const value of [
    [],
    ['SELECT 1'],
    ['SELECT 1', undefined],
    ['SELECT 1', null],
    ['SELECT 1', [], 'extra'],
    [42, []],
    ['SELECT $1', Array(1)],
  ]) {
    assert.throws(() => encodeQuery(value as never), { code: 'PGCLEAR_ENCODE' });
  }
});
