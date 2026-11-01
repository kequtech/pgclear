import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DriverError, defaultCodecs, type Field } from '../src/index.js';
import { registry } from '../src/codecs/index.js';
import { rowDecoder } from '../src/connection/operation.js';

const field: Field = {
  name: 'broken_column',
  dataTypeOid: 23,
  tableOid: 0,
  columnAttribute: 0,
  dataTypeSize: 4,
  typeModifier: -1,
  format: 'text',
};
test('per-column decoder failures retain safe metadata and the exact original cause', () => {
  const cause = new Error('private value from application decoder');
  const codecs = registry(
    defaultCodecs.with({
      oid: 23,
      text: {
        encode: String,
        decode() {
          throw cause;
        },
      },
    }),
  );
  for (const arrayMode of [false, true]) {
    const decode = rowDecoder([field], codecs, arrayMode);
    assert.throws(
      () => decode([Buffer.from('42')]),
      (error) => {
        assert.ok(error instanceof DriverError);
        assert.equal(error.code, 'PGCLEAR_DECODE');
        assert.equal(error.column, field.name);
        assert.equal(error.dataTypeOid, 23);
        assert.equal(error.cause, cause);
        assert.ok(!error.message.includes('private value'));
        assert.ok(!JSON.stringify(error).includes('private value'));
        return true;
      },
    );
  }
});

test('decoder selection and compatible legacy decoding failures have the same column context', () => {
  const cause = new Error('selection failed');
  for (const arrayMode of [false, true]) {
    assert.throws(
      () =>
        rowDecoder(
          [field],
          {
            decoder() {
              throw cause;
            },
          } as never,
          arrayMode,
        ),
      { code: 'PGCLEAR_DECODE', column: field.name, dataTypeOid: 23, cause },
    );
    const legacy = rowDecoder(
      [field],
      {
        decode() {
          throw cause;
        },
      } as never,
      arrayMode,
    );
    assert.throws(() => legacy([Buffer.from('42')]), {
      code: 'PGCLEAR_DECODE',
      column: field.name,
      dataTypeOid: 23,
      cause,
    });
  }
});

test('invalid UTF-8 and nested array decoding errors identify their enclosing column', () => {
  for (const [dataTypeOid, bytes] of [
    [25, Buffer.from([0xff])],
    [1007, Buffer.from('{1,bad}')],
  ] as const) {
    const decode = rowDecoder([{ ...field, dataTypeOid }], registry(defaultCodecs), false);
    assert.throws(() => decode([bytes]), {
      code: 'PGCLEAR_DECODE',
      column: field.name,
      dataTypeOid,
    });
  }
});

test('row decoder construction rejects object duplicates and preserves positional array fields', () => {
  const fields: Field[] = [{ ...field, dataTypeOid: 25 }, field];
  assert.throws(() => rowDecoder(fields, registry(defaultCodecs), false), {
    code: 'PGCLEAR_DECODE',
    outcome: 'unknown',
    column: field.name,
    dataTypeOid: 23,
  });
  const decode = rowDecoder(fields, registry(defaultCodecs), true);
  assert.deepEqual(decode([Buffer.from('text'), Buffer.from('42')]), ['text', 42]);
});
