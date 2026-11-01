import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtin, defaultCodecs, param, type Field, type PgArray } from '../src/index.js';
import { encodeParameter } from '../src/codecs/parameters.js';
import { registry } from '../src/codecs/index.js';

const first = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const second = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const field: Field = {
  name: 'ids',
  dataTypeOid: 2951,
  tableOid: 0,
  columnAttribute: 0,
  dataTypeSize: -1,
  typeModifier: -1,
  format: 'text',
};

test('UUID array parameters carry the UUID array type and preserve empty, null and nested values', () => {
  for (const values of [
    [],
    [first, null, second],
    [
      [first, null],
      [second, first],
    ],
  ] satisfies PgArray<string>[]) {
    const encoded = encodeParameter(param(values, builtin.uuidArray))!;
    assert.equal(encoded.oid, 2951);
    assert.equal(encoded.format, 0);
    assert.deepEqual(builtin.uuidArray.text!.decode(encoded.bytes!.toString()), values);
    assert.deepEqual(registry(defaultCodecs).decode(encoded.bytes, field), values);
  }
  const missing = encodeParameter(param(null, builtin.uuidArray))!;
  assert.equal(missing.oid, 2951);
  assert.equal(missing.bytes, null);
});

test('UUID arrays reuse scalar text validation and leave UUID syntax validation to PostgreSQL', () => {
  const text = ['not-a-uuid', '"quoted"', 'back\\slash'];
  const encoded = encodeParameter(param(text, builtin.uuidArray))!;
  assert.deepEqual(builtin.uuidArray.text!.decode(encoded.bytes!.toString()), text);
  for (const value of [[undefined], [1], ['a\0b'], ['\ud800'], Array(1), [[first], []]])
    assert.throws(
      () => encodeParameter(param(value as PgArray<string>, builtin.uuidArray)),
      TypeError,
    );
});

test('UUID array output metadata and explicit overrides follow existing scalar/array rules', () => {
  const custom = defaultCodecs.with({
    ...builtin.uuid,
    text: { encode: String, decode: (value: string) => value.toUpperCase(), typescript: 'string' },
  });
  assert.equal(defaultCodecs.typescript(2951), 'PgArray<string>');
  assert.equal(defaultCodecs.isDefaultDecoder(2951), true);
  assert.equal(custom.isDefaultDecoder(2951), false);
  const bytes = Buffer.from(builtin.uuidArray.text!.encode([first, null]));
  assert.deepEqual(registry(custom).decode(bytes, field), [first.toUpperCase(), null]);
  const explicit = custom.with(builtin.uuidArray);
  assert.equal(explicit.isDefaultDecoder(2951), true);
  assert.equal(explicit.typescript(2951), 'PgArray<string>');
  assert.ok(explicit.typescriptTypes().includes('PgArray<string>'));
  assert.deepEqual(registry(explicit).decode(bytes, field), [first, null]);
  assert.deepEqual(registry(defaultCodecs).decode(bytes, field), [first, null]);
});
