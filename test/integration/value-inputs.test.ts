/// <reference lib="esnext.temporal" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Temporal as PolyfillTemporal } from '@js-temporal/polyfill';
import {
  builtin,
  createTemporalCodecs,
  defaultCodecs,
  param,
  sql,
  type TemporalInput,
} from '../../src/index.js';
import { testConnection } from '../helpers/database.js';

test(
  'Date and bigint inputs work in classic, tagged, prepared and streamed queries',
  { timeout: 10000 },
  async () => {
    const { client } = await testConnection();
    try {
      await client.queryClassic("SET TIME ZONE 'UTC'");
      const date = new Date('2026-10-29T12:34:56.123Z');
      const value = 9223372036854775807n;
      const text = 'SELECT $1::timestamptz AS instant,$2::bigint AS value';
      const expected = [{ instant: '2026-10-29 12:34:56.123+00', value: String(value) }];
      assert.deepEqual((await client.queryClassic(text, [date, value])).rows, expected);
      assert.deepEqual(
        (await client.query(sql`SELECT ${date}::timestamptz AS instant,${value}::bigint AS value`))
          .rows,
        expected,
      );
      const prepared = await client.prepare(text);
      try {
        assert.deepEqual((await prepared.query([date, value])).rows, expected);
      } finally {
        await prepared.close();
      }
      const rows = [];
      for await (const row of client.stream([text, [date, value]], { batchSize: 1 }))
        rows.push(row);
      assert.deepEqual(rows, expected);
      assert.equal(
        (await client.queryClassic('SELECT $1::numeric AS value', [10n ** 40n])).rows[0]!.value,
        String(10n ** 40n),
      );
      await assert.rejects(client.queryClassic(text, [new Date(NaN), value]), {
        code: 'PGCLEAR_ENCODE',
        outcome: 'not-sent',
      });
      await assert.rejects(client.queryClassic('SELECT $1::bigint', [value + 1n]), {
        code: '22003',
      });
      assert.equal(
        (await client.queryClassic('SELECT $1::date AS value', [new Date('0000-01-01T00:00:00Z')]))
          .rows[0]!.value,
        '0001-01-01 BC',
      );
      assert.equal((await client.queryClassic('SELECT 1 AS value')).rows[0]!.value, 1);
    } finally {
      await client.close();
    }
  },
);

test(
  'optional Date and bigint output codecs control values without changing default registries',
  { timeout: 10000 },
  async () => {
    const { client } = await testConnection({
      codecs: defaultCodecs.with(builtin.timestamptzDate).with(builtin.int8BigInt),
    });
    try {
      await client.queryClassic("SET TIME ZONE 'Europe/Paris'");
      const date = new Date('1900-01-01T00:00:00Z');
      const rows = (
        await client.queryClassic(
          'SELECT $1::timestamptz AS instant,$2::bigint AS value,ARRAY[$2::bigint,NULL] AS values',
          [date, 42n],
        )
      ).rows;
      assert.deepEqual(rows, [{ instant: date, value: 42n, values: [42n, null] }]);
      await assert.rejects(client.queryClassic("SELECT 'infinity'::timestamptz"), {
        code: 'PGCLEAR_DECODE',
        outcome: 'confirmed',
      });
      assert.equal(
        (await client.queryClassic('SELECT $1::bigint AS value', [param(43n, builtin.int8BigInt)]))
          .rows[0]!.value,
        43n,
      );
    } finally {
      await client.close();
    }
  },
);

const native = typeof Temporal === 'undefined' ? undefined : Temporal;
for (const [name, implementation] of [
  ['polyfill', PolyfillTemporal],
  ['native', native],
] as const)
  test(
    `${name} Temporal inputs and output codecs round trip matching PostgreSQL types`,
    { timeout: 10000, skip: !implementation },
    async () => {
      const temporal = implementation!;
      const codecs = createTemporalCodecs<
        TemporalInput,
        TemporalInput,
        TemporalInput,
        TemporalInput
      >(temporal);
      const { client } = await testConnection({
        codecs: defaultCodecs
          .with(codecs.date)
          .with(codecs.timestamp)
          .with(codecs.timestamptz)
          .with(codecs.time),
      });
      try {
        await client.queryClassic("SET TIME ZONE 'Europe/Paris'");
        const date = temporal.PlainDate.from('2026-10-29');
        const timestamp = temporal.PlainDateTime.from('2026-10-29T12:34:56.123456');
        const instant = temporal.Instant.from('1900-01-01T00:00:00.123456Z');
        const time = temporal.PlainTime.from('12:34:56.123456');
        const result = await client.queryClassic(
          'SELECT $1::date AS day,$2::timestamp AS local,$3::timestamptz AS instant,$4::time AS time,ARRAY[$1::date,NULL] AS days',
          [date, timestamp, instant.toZonedDateTimeISO('Europe/Paris'), time],
        );
        const row = result.rows[0]!;
        assert.ok(row.day instanceof temporal.PlainDate);
        assert.ok(row.local instanceof temporal.PlainDateTime);
        assert.ok(row.instant instanceof temporal.Instant);
        assert.ok(row.time instanceof temporal.PlainTime);
        assert.equal(row.day.toString(), date.toString());
        assert.equal(row.local.toString(), timestamp.toString());
        assert.equal(row.instant.toString(), instant.toString());
        assert.equal(row.time.toString(), time.toString());
        assert.deepEqual(
          (row.days as (Temporal.PlainDate | null)[]).map((value) => value?.toString() ?? null),
          ['2026-10-29', null],
        );
        for (const [duration, expected] of [
          [temporal.Duration.from({ hours: 1, microseconds: 2 }), '1 hour 0.000002 seconds'],
          [temporal.Duration.from({ hours: -1 }), '-1 hour'],
          [temporal.Duration.from({ weeks: 1, days: 2 }), '9 days'],
          [
            temporal.Duration.from({ years: -1, months: -2, days: -3, microseconds: -1 }),
            '-1 year -2 months -3 days -0.000001 seconds',
          ],
        ] as const)
          assert.equal(
            (
              await client.queryClassic('SELECT $1::interval = $2::interval AS ok', [
                duration,
                expected,
              ])
            ).rows[0]!.ok,
            true,
          );
        assert.equal(
          (
            await client.queryClassic('SELECT $1::date AS value', [
              temporal.PlainDate.from('0000-01-01'),
            ])
          ).rows[0]!.value!.toString(),
          '0000-01-01',
        );
        await assert.rejects(
          client.queryClassic('SELECT $1::date', [
            temporal.PlainYearMonth.from('2026-10') as never,
          ]),
          { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' },
        );
      } finally {
        await client.close();
      }
    },
  );
