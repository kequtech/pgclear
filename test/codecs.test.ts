import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtin, defaultCodecs, json, param, type Codec, type Field } from '../src/index.js';
import { parseArray } from '../src/codecs/arrays.js';
import { registry } from '../src/codecs/index.js';
import { encodeQuery } from '../src/connection/query.js';

const field = (oid: number): Field => ({
  name: 'value',
  dataTypeOid: oid,
  tableOid: 0,
  columnAttribute: 0,
  dataTypeSize: -1,
  typeModifier: -1,
  format: 'text',
});
const decode = (oid: number, text: string, codecs = defaultCodecs) =>
  registry(codecs).decode(Buffer.from(text), field(oid));

test('array grammar preserves quoted NULL, escapes, nesting, dimensions, whitespace and delimiters', () => {
  const cases: [string, unknown[]][] = [
    ['{}', []],
    ['{NULL,"NULL","",null}', [null, 'NULL', '', null]],
    [
      '[0:1][-3:-2]={{a,b},{c,NULL}}',
      [
        ['a', 'b'],
        ['c', null],
      ],
    ],
    ['{ a , " b " , c\\ , NUL\\L }', ['a', ' b ', 'c ', 'NULL']],
    ['{"a,b","a\\\\b","a\\\"b","a{b}"}', ['a,b', 'a\\b', 'a"b', 'a{b}']],
    ['{{{a}},{{b}}}', [[['a']], [['b']]]],
  ];
  for (const [input, expected] of cases)
    assert.deepEqual(
      parseArray(input, (value) => value),
      expected,
    );
  assert.deepEqual(
    parseArray('{(1,1),(0,0);(3,3),(2,2)}', (value) => value, ';'),
    ['(1,1),(0,0)', '(3,3),(2,2)'],
  );
  let nullCalls = 0;
  assert.deepEqual(
    parseArray('{NULL,x}', (value) => {
      nullCalls++;
      return value;
    }),
    [null, 'x'],
  );
  assert.equal(nullCalls, 1);
});

test('malformed, ragged, unterminated and excessively nested arrays reject', () => {
  for (const input of [
    '',
    '{',
    '{a',
    '{a,,b}',
    '{a,}',
    '{,a}',
    '{"a}',
    '{"a"b}',
    '{a"b}',
    '{a{b}',
    '{{a},{b,c}}',
    '{a,{b}}',
    '{{}}',
    '{}garbage',
    '[1:3]={a,b}',
    '[2:1]={}',
    '[1:1][1:1]={a}',
    '{{{{{{{a}}}}}}}',
    '[2147483648:2147483648]={a}',
    '{a\\',
  ]) {
    assert.throws(() => parseArray(input, (value) => value), Error, input);
  }
});

test('scalar codecs retain precision and reject invalid representations', () => {
  assert.equal(decode(20, '9007199254740993'), 9007199254740993n);
  assert.equal(decode(1700, '9007199254740993.25'), '9007199254740993.25');
  assert.equal(decode(1082, 'infinity'), 'infinity');
  assert.equal(decode(1114, '2026-10-28 01:02:03.123456'), '2026-10-28 01:02:03.123456');
  assert.equal(decode(701, 'Infinity'), Infinity);
  assert.ok(Number.isNaN(decode(700, 'NaN')));
  for (const [oid, text] of [
    [16, 'yes'],
    [21, '32768'],
    [23, '2147483648'],
    [20, '9223372036854775808'],
    [1700, 'oops'],
    [701, ' '],
  ] as const)
    assert.throws(() => decode(oid, text));
  assert.deepEqual(decode(17, '\\x00ff5c'), new Uint8Array([0, 255, 92]));
  assert.deepEqual(decode(17, '\\000\\377\\\\'), new Uint8Array([0, 255, 92]));
  assert.throws(() => decode(17, '\\x0g'));
});

test('registry changes are immutable and built-in arrays derive from the selected scalar', () => {
  const codec = {
    oid: 23,
    text: { encode: (value: string) => value, decode: (value: string) => 'n:' + value },
  };
  const first = defaultCodecs.with(codec);
  codec.text.decode = (value) => 'changed:' + value;
  const second = first.with(codec);
  assert.equal(decode(23, '1'), 1);
  assert.equal(decode(23, '1', first), 'n:1');
  assert.deepEqual(decode(1007, '{1,NULL,2}', first), ['n:1', null, 'n:2']);
  assert.equal(decode(23, '1', second), 'changed:1');
  const array: Codec<string> = {
    oid: 1007,
    text: { encode: (value) => value, decode: (value) => 'array:' + value },
  };
  for (const registry of [
    defaultCodecs.with(array).with(codec),
    defaultCodecs.with(codec).with(array),
  ]) {
    assert.equal(decode(1007, '{1}', registry), 'array:{1}');
    assert.equal(decode(23, '1', registry), 'changed:1');
  }
  assert.deepEqual(decode(1231, '{9007199254740993.25,NULL}'), ['9007199254740993.25', null]);
  assert.deepEqual(decode(1016, '{{1,NULL},{2,3}}'), [
    [1n, null],
    [2n, 3n],
  ]);
});

test('custom null/undefined outputs and absent text decoders are preserved', () => {
  for (const value of [null, undefined]) {
    const codecs = defaultCodecs.with({ oid: 23, text: { encode: () => '', decode: () => value } });
    assert.equal(decode(23, '1', codecs), value);
    assert.deepEqual(decode(1007, '{1,NULL}', codecs), [value, null]);
  }
  const binaryOnly = defaultCodecs.with({
    oid: 23,
    binary: { encode: () => new Uint8Array(), decode: () => 0 },
  });
  assert.equal(decode(23, '1', binaryOnly), '1');
  assert.deepEqual(decode(1007, '{1}', binaryOnly), ['1']);
  assert.equal(decode(987654, 'opaque'), 'opaque');
  const asynchronous = defaultCodecs.with({
    oid: 23,
    text: {
      encode: String,
      decode: async () => {
        throw Error('fixture');
      },
    },
  });
  assert.throws(() => decode(23, '1', asynchronous), /synchronous/);
  assert.throws(() => decode(1007, '{1}', asynchronous), /synchronous/);
});

test('JSON text avoids parse precision loss; parameters encode lazily before wire dispatch', () => {
  assert.equal(
    decode(3802, '{"n":9007199254740993}', defaultCodecs.with(builtin.jsonbText)),
    '{"n":9007199254740993}',
  );
  assert.deepEqual(decode(3802, '{"n":9007199254740993}'), { n: 9007199254740992 });
  let calls = 0;
  const parameter = param(1, {
    oid: 23,
    text: {
      encode: (value) => {
        calls++;
        return String(value);
      },
      decode: Number,
    },
  });
  assert.equal(calls, 0);
  encodeQuery({ text: 'SELECT $1', values: [parameter] });
  assert.equal(calls, 1);
  encodeQuery({
    text: 'SELECT $1',
    values: [param(null, { oid: 23, text: { encode: () => assert.fail(), decode: Number } })],
  });
  for (const value of [undefined, 1n, Symbol('x'), () => 0])
    assert.throws(() => encodeQuery({ text: 'SELECT $1', values: [json(value)] }));
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => encodeQuery({ text: 'SELECT $1', values: [json(cycle)] }));
  assert.throws(() => param(1, { oid: 0, text: { encode: String, decode: Number } }), {
    code: 'PGCLEAR_CONFIGURATION',
  });
  assert.throws(() => param(1, builtin.int4, 'binary'), { code: 'PGCLEAR_CONFIGURATION' });
});

test('repeatable array samples round trip quoted characters and reject truncated forms', () => {
  let seed = 0x325ad;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = ['a', ',', '{', '}', '"', '\\', ' ', 'é'];
  for (let run = 0; run < 100; run++) {
    const values = Array.from({ length: random() % 8 }, () =>
      random() % 4 === 0
        ? null
        : Array.from({ length: random() % 16 }, () => alphabet[random() % alphabet.length]!).join(
            '',
          ),
    );
    const text = builtin.textArray.text!.encode(values);
    assert.deepEqual(
      parseArray(text, (value) => value),
      values,
      `seed=0x325ad run=${run}`,
    );
    assert.throws(() => parseArray(text.slice(0, -1), (value) => value));
  }
});

test('typed array codecs encode rectangular nested arrays and reject invalid shapes locally', () => {
  const codec = builtin.int4Array.text!;
  const values = [
    [1, null],
    [2, 3],
  ];
  assert.deepEqual(codec.decode(codec.encode(values)), values);
  for (const value of [[[1], [2, 3]], [[], []], [1, [2]], [undefined], [[[[[[[1]]]]]]]]) {
    assert.throws(() => codec.encode(value as never));
  }
});
