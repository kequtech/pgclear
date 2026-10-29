import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtin, defaultCodecs, json, param, type Codec, type Field } from '../src/index.js';
import { parseArray } from '../src/codecs/arrays.js';
import { registry } from '../src/codecs/index.js';
import { encodeQuery } from '../src/connection/query.js';

test('asynchronous parameter encoders reject locally and observe rejected promises', async () => {
  for (const format of ['text', 'binary'] as const) {
    const codec: Codec<string> = {
      oid: 25,
      [format]: {
        encode: (async () => {
          throw Error('encoder fixture');
        }) as never,
        decode: () => 'value',
      },
    };
    assert.throws(() => encodeQuery(['SELECT $1', [param('value', codec, format)]]), /synchronous/);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
});

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

test('public TypeScript representations follow the selected text decoders', () => {
  for (const [oid, expected] of [
    [16, 'boolean'],
    [23, 'number'],
    [20, 'string'],
    [1700, 'string'],
    [17, 'globalThis.Uint8Array'],
    [1082, 'string'],
    [1114, 'string'],
    [1184, 'string'],
    [114, 'unknown'],
    [3802, 'unknown'],
    [1007, 'PgArray<number>'],
    [1016, 'PgArray<string>'],
    [1231, 'PgArray<string>'],
    [987654, 'string'],
  ] as const)
    assert.equal(defaultCodecs.typescript(oid), expected);
  const custom = defaultCodecs.with({
    oid: 23,
    text: { encode: String, decode: (value) => ({ value }) },
  });
  assert.equal(custom.typescript(23), undefined);
  assert.equal(custom.typescript(1007), undefined);
  assert.equal(custom.with(builtin.int4Array).typescript(1007), 'PgArray<number>');
  assert.equal(custom.with(builtin.int4).typescript(23), 'number');
  assert.equal(defaultCodecs.with(builtin.jsonbText).typescript(3802), 'string');
  const int4AsText = defaultCodecs.with({ ...builtin.text, oid: builtin.int4.oid });
  assert.equal(int4AsText.typescript(23), 'string');
  assert.equal(int4AsText.typescript(1007), 'PgArray<string>');
  assert.equal(defaultCodecs.typescript(20), 'string');
  const binaryOnly = defaultCodecs.with({
    oid: 23,
    binary: { encode: () => new Uint8Array(), decode: () => 0 },
  });
  assert.equal(binaryOnly.typescript(23), 'string');
  assert.equal(binaryOnly.typescript(1007), 'PgArray<string>');
  for (const oid of [0, -1, 1.5, NaN, Infinity, 0x100000000])
    assert.throws(() => defaultCodecs.typescript(oid), { code: 'PGCLEAR_CONFIGURATION' });
});

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
  for (const value of ['0', '+42', '-0', '-9223372036854775808', '9223372036854775807']) {
    assert.equal(builtin.int8.text!.encode(value), value);
    assert.equal(decode(20, value), value);
  }
  for (const value of ['9223372036854775808', '-9223372036854775809', '1.5', 'oops'])
    assert.throws(() => builtin.int8.text!.encode(value), TypeError);
  assert.equal(decode(20, '9007199254740993'), '9007199254740993');
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
    ['1', null],
    ['2', '3'],
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
  assert.throws(() => decode(23, '1', asynchronous), TypeError);
  assert.throws(() => decode(1007, '{1}', asynchronous), TypeError);
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

test('UTF8 field decoding preserves every leading U+FEFF before built-in and custom codecs', () => {
  for (const text of ['\uFEFF', '\uFEFFhello', '\uFEFF\uFEFFhello', 'hello\uFEFF', '\uFEFFé😀']) {
    assert.equal(decode(25, text), text);
    assert.equal(decode(987654, text), text);
    assert.equal(
      decode(
        25,
        text,
        defaultCodecs.with({
          oid: 25,
          text: { encode: (value: string) => value, decode: (value) => 'custom:' + value },
        }),
      ),
      'custom:' + text,
    );
  }
  assert.throws(
    () => registry(defaultCodecs).decode(Buffer.from([0xef, 0xbb, 0xbf, 0xff]), field(25)),
    TypeError,
  );
});

test('selected field decoders keep registry snapshots, null bypass and validation', async () => {
  let calls = 0;
  const custom = defaultCodecs.with({
    oid: 23,
    text: {
      encode: String,
      decode: (value) => {
        calls++;
        return 'n:' + value;
      },
    },
  });
  const scalar = registry(custom).decoder(field(23));
  const array = registry(custom).decoder(field(1007));
  const overridden = registry(custom.with(builtin.int4)).decoder(field(23));
  assert.equal(scalar(null), null);
  assert.equal(calls, 0);
  assert.equal(scalar(Buffer.from('1')), 'n:1');
  assert.deepEqual(array(Buffer.from('{2,NULL,3}')), ['n:2', null, 'n:3']);
  assert.equal(calls, 3);
  assert.equal(overridden(Buffer.from('4')), 4);
  assert.equal(scalar(Buffer.from('5')), 'n:5');
  assert.throws(() => overridden(Buffer.from('2147483648')), TypeError);
  assert.throws(() => scalar(Buffer.from([0xff])), TypeError);
  const binary = registry(custom).decoder({ ...field(23), format: 'binary' });
  assert.equal(binary(null), null);
  assert.throws(() => binary(Buffer.from('1')), TypeError);
  const asynchronous = registry(
    defaultCodecs.with({
      oid: 23,
      text: {
        encode: String,
        decode: async () => {
          throw Error('selected decoder fixture');
        },
      },
    }),
  ).decoder(field(1007));
  assert.throws(() => asynchronous(Buffer.from('{1}')), /synchronous/);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('array syntax consumes only PostgreSQL ASCII whitespace and preserves Unicode data', () => {
  const unicode = [
    '\u0085',
    '\u00a0',
    '\u1680',
    '\u2000',
    '\u2001',
    '\u2002',
    '\u2003',
    '\u2004',
    '\u2005',
    '\u2006',
    '\u2007',
    '\u2008',
    '\u2009',
    '\u200a',
    '\u2028',
    '\u2029',
    '\u202f',
    '\u205f',
    '\u3000',
    '\ufeff',
  ];
  for (const char of unicode) {
    const values = [char + 'hello', 'hello' + char, char, char + 'NULL' + char];
    assert.deepEqual(
      parseArray('{' + values.join(',') + '}', (value) => value),
      values,
      JSON.stringify(char),
    );
    assert.deepEqual(
      parseArray('[0:3]={' + values.join(',') + '}', (value) => value),
      values,
    );
    assert.deepEqual(
      parseArray('{"' + char + 'hello","hello' + char + '"}', (value) => value),
      [char + 'hello', 'hello' + char],
    );
    assert.deepEqual(
      parseArray('{ ' + char + 'hello' + char + ' \t}', (value) => value),
      [char + 'hello' + char],
    );
    for (const input of [char + '{hello}', '{hello}' + char, '{"hello"' + char + '}'])
      assert.throws(() => parseArray(input, (value) => value));
  }
});

test('array grammar trims only unescaped ASCII syntax whitespace', () => {
  for (const char of [' ', '\t', '\n', '\r', '\v', '\f']) {
    assert.deepEqual(
      parseArray(
        char + '{' + char + 'hello' + char + ',' + char + 'NULL' + char + '}' + char,
        (value) => value,
      ),
      ['hello', null],
    );
    assert.deepEqual(
      parseArray('{\\' + char + 'hello,hello\\' + char + '}', (value) => value),
      [char + 'hello', 'hello' + char],
    );
    assert.deepEqual(
      parseArray('{"' + char + 'hello' + char + '"}', (value) => value),
      [char + 'hello' + char],
    );
  }
});
