/// <reference lib="esnext.temporal" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Temporal as PolyfillTemporal } from '@js-temporal/polyfill';
import {
  builtin,
  createTemporalCodecs,
  defaultCodecs,
  type InputValue,
  type TemporalInput,
} from '../src/index.js';
import { temporalText } from '../src/codecs/temporal.js';
import { encodeQuery } from '../src/connection/query.js';

test('Date encoding is UTC, validates dates and handles PostgreSQL year numbering', () => {
  for (const [iso, expected] of [
    ['2026-10-29T12:34:56.123Z', '2026-10-29T12:34:56.123Z'],
    ['0000-01-01T00:00:00.000Z', '0001-01-01T00:00:00.000Z BC'],
    ['-000001-01-01T00:00:00.000Z', '0002-01-01T00:00:00.000Z BC'],
    ['+010000-01-01T00:00:00.000Z', '10000-01-01T00:00:00.000Z'],
  ] as const) {
    const value = new Date(iso);
    assert.equal(temporalText(value), expected);
    assert.equal(builtin.timestamptzDate.text!.encode(value), expected);
  }
  assert.throws(() => encodeQuery(['SELECT $1', [new Date(NaN)]]), { code: 'PGCLEAR_ENCODE' });
  assert.equal(temporalText({ toString: () => '2026-01-01' }), undefined);
});

test('optional Date and bigint codecs preserve exact defaults and derived array representations', () => {
  const selected = defaultCodecs.with(builtin.int8BigInt).with(builtin.timestamptzDate);
  assert.equal(defaultCodecs.typescript(20), 'string');
  assert.equal(defaultCodecs.typescript(1184), 'string');
  assert.equal(selected.typescript(20), 'bigint');
  assert.equal(selected.typescript(1016), 'PgArray<bigint>');
  assert.equal(selected.typescript(1184), 'globalThis.Date');
  assert.equal(selected.typescript(1185), 'PgArray<globalThis.Date>');
  assert.equal(defaultCodecs.with(builtin.int8BigIntArray).typescript(1016), 'PgArray<bigint>');
  const codec = builtin.int8BigInt.text!;
  for (const value of [-9223372036854775808n, 0n, 9223372036854775807n])
    assert.equal(codec.decode(codec.encode(value)), value);
  assert.throws(() => codec.encode(9223372036854775808n), TypeError);
  assert.throws(() => codec.decode('-9223372036854775809'), TypeError);
  assert.throws(() => codec.encode('1' as never), TypeError);
  const date = builtin.timestamptzDate.text!;
  assert.equal(
    date.decode('2026-10-29 14:34:56.123456+02').toISOString(),
    '2026-10-29T12:34:56.123Z',
  );
  assert.equal(
    date.decode('1900-01-01 00:09:21+00:09:21').toISOString(),
    '1900-01-01T00:00:00.000Z',
  );
  assert.equal(date.decode('0001-01-01 00:00:00+00 BC').toISOString(), '0000-01-01T00:00:00.000Z');
  for (const value of ['infinity', '-infinity', 'not a timestamp', '294276-12-31 00:00:00+00'])
    assert.throws(() => date.decode(value), TypeError);
});

const native = typeof Temporal === 'undefined' ? undefined : Temporal;
for (const [name, implementation] of [
  ['polyfill', PolyfillTemporal],
  ['native', native],
] as const)
  test(
    `${name} Temporal inputs and opt-in codecs retain calendar and instant semantics`,
    { skip: !implementation },
    () => {
      const temporal = implementation!;
      const codecs = createTemporalCodecs<
        TemporalInput,
        TemporalInput,
        TemporalInput,
        TemporalInput
      >(temporal);
      for (const [value, expected] of [
        [temporal.PlainDate.from('2026-10-29'), '2026-10-29'],
        [temporal.PlainDate.from('2026-10-29[u-ca=hebrew]'), '2026-10-29'],
        [temporal.PlainTime.from('12:34:56.123456'), '12:34:56.123456'],
        [temporal.PlainDateTime.from('2026-10-29T12:34:56.123456'), '2026-10-29T12:34:56.123456'],
        [temporal.Instant.from('2026-10-29T12:34:56.123456Z'), '2026-10-29T12:34:56.123456Z'],
        [
          temporal.ZonedDateTime.from('2026-10-29T13:34:56.123456+01:00[Europe/Budapest]'),
          '2026-10-29T12:34:56.123456Z',
        ],
        [temporal.Duration.from({ hours: 1, microseconds: 2 }), 'PT1H0.000002S'],
      ] as const) {
        const input: InputValue = value;
        assert.equal(temporalText(input), expected);
        assert.doesNotThrow(() => encodeQuery(['SELECT $1', [input]]));
      }
      assert.equal(codecs.date.text!.decode('2026-10-29').toString(), '2026-10-29');
      assert.equal(codecs.date.text!.decode('0001-01-01 BC').toString(), '0000-01-01');
      assert.equal(
        codecs.timestamp.text!.decode('2026-10-29 12:34:56.123456').toString(),
        '2026-10-29T12:34:56.123456',
      );
      assert.equal(
        codecs.timestamptz.text!.decode('2026-10-29 14:34:56.123456+02').toString(),
        '2026-10-29T12:34:56.123456Z',
      );
      assert.equal(
        codecs.date.text!.encode(temporal.PlainDate.from('0000-01-01')),
        '0001-01-01 BC',
      );
      assert.throws(() => codecs.timestamptz.text!.decode('infinity'));
      for (const value of [
        temporal.PlainYearMonth.from('2026-10'),
        temporal.PlainMonthDay.from('10-29'),
      ])
        assert.equal(temporalText(value), undefined);
      const registry = defaultCodecs
        .with(codecs.date)
        .with(codecs.timestamp)
        .with(codecs.timestamptz);
      assert.equal(registry.typescript(1082), 'Temporal.PlainDate');
      assert.equal(registry.typescript(1182), 'PgArray<Temporal.PlainDate>');
      const imported = createTemporalCodecs<
        TemporalInput,
        TemporalInput,
        TemporalInput,
        TemporalInput
      >(temporal, {
        typescriptNamespace: 'import("example-temporal").Temporal',
      });
      assert.equal(
        defaultCodecs.with(imported.date).typescript(1082),
        'import("example-temporal").Temporal.PlainDate',
      );
    },
  );

test('a Temporal provider preserves its concrete output types without global declarations', () => {
  const codecs = createTemporalCodecs(PolyfillTemporal, {
    typescriptNamespace: 'import("@js-temporal/polyfill").Temporal',
  });
  const date: PolyfillTemporal.PlainDate = codecs.date.text!.decode('2026-10-29');
  assert.ok(date instanceof PolyfillTemporal.PlainDate);
  assert.equal(codecs.date.text!.encode(date), '2026-10-29');
});
