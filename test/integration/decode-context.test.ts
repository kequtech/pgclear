import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCodecs, DriverError, type RowStream } from '../../src/index.js';
import { testConnection } from '../helpers/database.js';

function check(error: unknown, cause: Error): boolean {
  assert.ok(error instanceof DriverError);
  assert.equal(error.code, 'PGCLEAR_DECODE');
  assert.equal(error.outcome, 'confirmed');
  assert.equal(error.column, 'broken_column');
  assert.equal(error.dataTypeOid, 23);
  assert.ok(!error.message.includes('secret'));
  assert.ok(!JSON.stringify(error).includes('secret'));
  let original: unknown = error;
  while (original instanceof Error && original.cause !== undefined) original = original.cause;
  assert.equal(original, cause);
  return true;
}
async function consume(stream: RowStream<object>) {
  for await (const row of stream) void row;
}

test(
  'query, prepared, script and stream decode errors keep context through outcome recovery',
  { timeout: 10000 },
  async () => {
    const cause = new Error('secret decoder value');
    const { client } = await testConnection({
      codecs: defaultCodecs.with({
        oid: 23,
        text: {
          encode: String,
          decode() {
            throw cause;
          },
        },
      }),
    });
    const text = 'SELECT $1::text AS payload, 2::integer AS broken_column';
    try {
      for (const run of [
        () => client.queryClassic(text, ['secret parameter']),
        () => client.queryClassic(text, ['secret parameter'], { rowMode: 'array' }),
      ])
        await assert.rejects(run, (error) => check(error, cause));
      const prepared = await client.prepare(text);
      try {
        for (const run of [
          () => prepared.query(['secret parameter']),
          () => prepared.query(['secret parameter'], { rowMode: 'array' }),
        ])
          await assert.rejects(run, (error) => check(error, cause));
      } finally {
        await prepared.close();
      }
      for (const start of [
        () => client.stream({ text, values: ['secret parameter'] }),
        () => client.stream({ text, values: ['secret parameter'] }, { rowMode: 'array' }),
      ]) {
        const stream = start();
        await assert.rejects(consume(stream), (error) => check(error, cause));
        await assert.rejects(stream.completion, (error) => check(error, cause));
      }
      await assert.rejects(
        client.script("SELECT 'secret SQL text' AS payload, 2::integer AS broken_column"),
        (error) => check(error, cause),
      );
      await assert.rejects(
        client.script('SELECT 2::integer AS broken_column; SELECT 1/0'),
        (error) => {
          assert.ok(error instanceof AggregateError);
          check(error.errors[0], cause);
          assert.equal(error.errors[1].code, '22012');
          return true;
        },
      );
      await assert.rejects(client.queryClassic("SELECT 'a' AS duplicate, 'b' AS duplicate"), {
        code: 'PGCLEAR_DECODE',
        outcome: 'confirmed',
        column: 'duplicate',
        dataTypeOid: 25,
      });
      assert.deepEqual((await client.queryClassic("SELECT 'recovered' AS status")).rows, [
        { status: 'recovered' },
      ]);
    } finally {
      await client.close();
    }
  },
);
