# Values and codecs

[Documentation](README.md) · [Queries](queries.md) · [Configuration](configuration.md)

Input encoding and result decoding are separate choices. A `Date` parameter can be written to a
`timestamptz` column while that column still comes back as a string. A row type annotation changes
neither choice.

## Plain parameters

| JavaScript input                | Encoding                                                      |
| ------------------------------- | ------------------------------------------------------------- |
| `null`                          | SQL NULL                                                      |
| `string`                        | Text; PostgreSQL infers the destination type                  |
| Finite `number`                 | Decimal text; integer numbers must be safe integers           |
| `bigint`                        | Exact decimal text; PostgreSQL checks the destination's range |
| `boolean`                       | PostgreSQL bool                                               |
| `Uint8Array` (including Buffer) | Binary bytea                                                  |
| Valid `Date`                    | UTC text                                                      |
| Supported Temporal value        | ISO date/time/interval text                                   |

`undefined`, plain objects, and arrays are rejected. Use `json` or `param` for them. Cast an SQL
placeholder when the server needs help choosing its type, such as `$1::integer` or `$1::timestamptz`.
Do not mutate bound values or codec state until the operation settles.

## Default output types

| PostgreSQL type                                      | JavaScript value                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| int2/smallint, int4/integer, smallserial/serial, oid | `number`                                                          |
| int8/bigint, bigserial                               | Exact decimal `string`                                            |
| numeric/decimal                                      | `string`, including NaN/infinity spellings                        |
| float4/real, float8/double precision                 | `number`, including NaN/infinities                                |
| bool/boolean                                         | `boolean`                                                         |
| text, varchar, char, name, UUID, enums               | `string`                                                          |
| date, timestamp, timestamptz, time, timetz, interval | `string`                                                          |
| json/jsonb                                           | `JSON.parse` output, typed as `unknown`                           |
| bytea                                                | `Uint8Array`                                                      |
| Supported built-in arrays                            | Nested arrays of decoded elements, with `null` elements preserved |
| Unrecognized types and dynamic array OIDs            | Wire-text `string`                                                |
| SQL NULL                                             | `null`, without calling a decoder                                 |

The server's result OID selects the decoder. `count(*)` is int8, so its column value is a string.
Domains reported with their underlying type use that type's decoder. Money, network addresses,
ranges, composites, bit strings, XML, and other unknown types stay text unless overridden. pgclear
does not fetch catalogs to discover types automatically. Temporal text retains server precision and
supported infinity values without JavaScript Date interpretation.

## JSON

```ts
import { json } from '@kequtech/pgclear';

const result = await pool.queryClassic('SELECT $1::jsonb AS settings', [json({ enabled: true })]);
```

`json(value, type = 'jsonb')` uses `JSON.stringify`. Pass `'json'` as the second argument to select
PostgreSQL json instead of jsonb.

- Plain `null` is SQL NULL; `json(null)` is JSON null.
- `json('text')` encodes a JSON string, not a pre-encoded document.
- Cycles, bigint, and values producing no JSON text reject before dispatch.
- Standard JSON behavior still applies, including omission of undefined object properties.

JSON outputs use JavaScript numbers, so large numeric tokens can lose precision. Parsed JSON null
and SQL NULL both become JavaScript null. To retain the server's JSON text, use raw-text codecs:

```ts
import { builtin, createPool, defaultCodecs, param } from '@kequtech/pgclear';

const pool = createPool({
  connectionString: process.env.DATABASE_URL!,
  codecs: defaultCodecs.with(builtin.jsonText).with(builtin.jsonbText),
});
try {
  const result = await pool.queryClassic<{ payload: string }>('SELECT $1::jsonb AS payload', [
    param('{"n":9007199254740993}', builtin.jsonbText),
  ]);
  console.log(result.rows[0]?.payload); // Server JSON text; no JavaScript number conversion.
} finally {
  await pool.close();
}
```

This preserves numeric tokens from JavaScript conversion; PostgreSQL jsonb can still normalize
formatting and object structure.

## PostgreSQL arrays

```ts
import { builtin, param } from '@kequtech/pgclear';

const result = await pool.queryClassic<{ id: number }>(
  'SELECT id FROM generate_series(1, 5) AS ids(id) WHERE id = ANY($1::integer[])',
  [param([1, 3, 5], builtin.int4Array)],
);
```

Arrays use recursive `PgArray<T>` values. Input arrays must be rectangular, have at most six
dimensions, and contain no undefined elements or nested empty arrays. A top-level empty array is
supported. SQL NULL elements are `null`.

Built-in array parsing preserves shape and null elements but omits lower-bound metadata. Default
array decoders follow the selected scalar decoder; an explicit array override wins. Dynamic enum,
domain, and extension array OIDs stay text unless registered.

Named input codecs include `int4Array` (numbers), `int8Array` (strings), `numericArray` (strings),
`textArray` (strings), and `int8BigIntArray` (bigints). For example, exact decimal values use
`param(['9007199254740993.25', null], builtin.numericArray)`.

## Explicit parameters

`param(value, codec, format?)` supplies an OID and encoder. A codec contains `oid` and complete
synchronous `text` and/or `binary` encode/decode pairs. The default format is text when available,
otherwise binary. An explicit format must be implemented by that codec.

```ts
import { builtin, param } from '@kequtech/pgclear';

await pool.queryClassic('SELECT $1 AS exact, $2 AS missing', [
  param('9007199254740993', builtin.int8),
  param(null, builtin.int4),
]);
```

`null` encodes SQL NULL without invoking the encoder. Encoding happens before dispatch, including
for `json`. Binary parameters are supported; ordinary results use text format. Changing the result
registry does not change plain-bind rules or the encoder carried by `param`.

The `builtin` object exposes these codecs:

| Group                | Codec names                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| Numbers and booleans | `bool`, `int2`, `int4`, `int8`, `int8BigInt`, `float4`, `float8`, `numeric` |
| Text and bytes       | `text`, `uuid`, `bytea`                                                     |
| JSON                 | `json`, `jsonb`, `jsonText`, `jsonbText`                                    |
| Temporal             | `date`, `timestamp`, `timestamptz`, `timestamptzDate`                       |
| Arrays               | `int4Array`, `int8Array`, `int8BigIntArray`, `numericArray`, `textArray`    |

## Exact integers

By default every int8 result is a decimal string, even `'1'`. This preserves PostgreSQL's full
signed 64-bit range and works with `JSON.stringify` without a replacer. `builtin.int8` and
`builtin.int8Array` accept strings; bigint values can also bind directly.

For bigint output, select `defaultCodecs.with(builtin.int8BigInt)`. Its default int8 array decoder
follows automatically. `builtin.int8BigIntArray` supports explicit bigint-array parameters. These
codecs enforce the signed 64-bit range. Bigint outputs need a replacer for `JSON.stringify`.
Converting arbitrary int8 text to Number can lose precision.

Command metadata is independent: `rowCount` remains `number | null` regardless of codecs. See
[results and counts](queries.md#results-and-row-types).

## Dates and Temporal

```ts
await pool.queryClassic('SELECT $1::timestamptz AS occurred_at, $2::bigint AS sequence', [
  new Date(),
  9007199254740993n,
]);
```

Invalid Date inputs reject before dispatch. Date inputs serialize in UTC. A `timestamptz`
destination preserves the instant; a `date` or `timestamp without time zone` destination uses the
UTC calendar fields. For calendar dates or wall-clock times, prefer an ISO string or the
corresponding Temporal plain type.

Supported native/polyfilled Temporal inputs are `PlainDate`, `PlainTime`, `PlainDateTime`,
`Instant`, `ZonedDateTime`, and `Duration`. ZonedDateTime preserves the instant without storing its
IANA zone name. Calendar annotations are omitted; durations encode as ISO intervals. Incomplete
`PlainYearMonth` and `PlainMonthDay` values need an explicit conversion or codec. PostgreSQL applies
its own precision and range limits.

### Date output

```ts
import { builtin, defaultCodecs } from '@kequtech/pgclear';

const result = await pool.queryClassic<{ occurred_at: Date }>(
  'SELECT current_timestamp AS occurred_at',
  undefined,
  { codecs: defaultCodecs.with(builtin.timestamptzDate) },
);
```

`timestamptzDate` returns millisecond-precision Date objects. It also affects derived timestamptz
arrays when selected in a registry. Other temporal types retain their defaults.

### Temporal output

Supply native Temporal when your runtime provides it, or a compatible polyfill. For example,
install `@js-temporal/polyfill` in your application and pass its constructors:

```ts
import { Temporal } from '@js-temporal/polyfill';
import { createTemporalCodecs, defaultCodecs } from '@kequtech/pgclear';

const temporal = createTemporalCodecs(Temporal, {
  typescriptNamespace: 'import("@js-temporal/polyfill").Temporal',
});
const codecs = defaultCodecs
  .with(temporal.date) // Temporal.PlainDate
  .with(temporal.timestamp) // Temporal.PlainDateTime
  .with(temporal.timestamptz) // Temporal.Instant
  .with(temporal.time); // Temporal.PlainTime
// Pass codecs to createPool/connect, or as a query option.
```

pgclear does not load a polyfill or change globals. Outputs stay strings unless you select codecs,
regardless of runtime Temporal support. PostgreSQL does not retain the original zone name for
timestamptz.

The default metadata namespace is `'Temporal'`. Native Temporal declarations need a TypeScript
library containing `ESNext.Temporal`. The polyfill namespace above lets downstream generated types
refer to the application's installed polyfill. The namespace is a trusted TypeScript expression.

Date/Temporal codecs reject infinity and out-of-range values. Temporal codecs assume the default
ISO DateStyle. Default string decoding preserves server text, including infinity. Decoder errors
drain the response before session recovery.

## Select result codecs

`defaultCodecs.with(codec)` returns a new immutable registry. Pass it to `connect` or `createPool`
for default result decoding. Other pools and `defaultCodecs` remain unchanged. SQL NULL bypasses
all decoders. A codec without a text decoder leaves ordinary text results unchanged.

### Per-query codecs

```ts
import { defaultCodecs } from '@kequtech/pgclear';

const result = await pool.queryClassic(
  'SELECT oid, typname FROM pg_catalog.pg_type WHERE oid = $1',
  [23],
  { codecs: defaultCodecs },
);
```

Queries, prepared queries, and streams accept an operation-local `codecs` registry. Streams keep
that choice across batches. Scripts, Describe, and COPY do not accept it. Registries must come
from `defaultCodecs` or `.with()`; hand-built registry objects reject before encoding.

Every executor exposes its selected default registry as `.codecs`. Reading it requires no SQL or
connection acquisition and remains safe after a handle expires. Operations still enforce lifecycle
rules. Tools reading catalogs on an application session can select `defaultCodecs` for one query
without replacing the session or changing its default registry.

### Custom representations

Reuse a built-in codec when its representation fits. This example reads and writes int4 as text:

```ts
import { builtin, defaultCodecs, param, type Codec } from '@kequtech/pgclear';

const int4AsText: Codec<string> = { ...builtin.text, oid: builtin.int4.oid };
const codecs = defaultCodecs.with(int4AsText);
const result = await pool.queryClassic<{ id: string }>(
  'SELECT $1 AS id',
  [param('42', int4AsText)],
  { codecs },
);
console.log(result.rows[0]?.id); // '42'
```

The registry selects output decoding; `param` selects input encoding. PostgreSQL validates the
encoded text against the selected type. Scalar overrides affect default built-in array decoding,
so int4[] becomes `PgArray<string>` here. Explicit array overrides take precedence.

Custom codec functions must be synchronous. Promise results reject, with their rejections observed.
Invalid result data raises `PGCLEAR_DECODE` after protocol recovery. Codec registrations snapshot
functions and metadata; mutable state captured by those functions remains your responsibility.

## Type metadata for downstream tools

`codecs.isDefaultDecoder(oid)` reports whether that OID's effective text decoder is known to match
the driver's default. Unrelated codec changes do not affect it: selecting Date output changes the
timestamptz decoder but leaves an unregistered enum's raw-text decoder at its default. Tools can
combine this fact with catalog enum labels without guessing from a declared `string` output type.

Derived built-in arrays follow their element decoder. Explicit built-in default decoder functions
are recognized, including from another copy of the same package version. Custom functions and
wrappers are conservatively nondefault even if they declare `string` or return unchanged text. An
explicit text decoder for an otherwise unknown OID is also nondefault. Binary-only registrations
leave unknown OIDs' raw text unchanged, but replace default scalar/array text decoding with raw text.
This method validates OIDs like `typescript`; it does not query catalogs or infer enum labels.

`codecs.typescript(oid)` returns the known non-NULL text-result representation: for example,
`'string'`, `'PgArray<number>'`, or `'globalThis.Uint8Array'`. JSON has the known type `'unknown'`.
An unfamiliar custom decoder without a declaration returns `undefined`; an unknown OID that stays
text has type `'string'`. SQL nullability, enum choices, domain resolution, and encoder input types
are separate concerns.

Reusing a built-in decoder preserves its known representation. For a new decoder, declare a
non-NULL output type expression alongside the implementation:

```ts
import { builtin, defaultCodecs, type Codec } from '@kequtech/pgclear';

const wrappedInteger: Codec<{ value: number }> = {
  oid: builtin.int4.oid,
  text: {
    encode: ({ value }) => builtin.int4.text!.encode(value),
    decode: (text) => ({ value: builtin.int4.text!.decode(text) }),
    typescript: '{ value: number }',
  },
};
const codecs = defaultCodecs.with(wrappedInteger);
console.log(codecs.typescript(23)); // '{ value: number }'
console.log(codecs.typescript(1007)); // 'PgArray<{ value: number }>'
```

`Codec<T>` checks function signatures during compilation, but T is erased at runtime. The
`typescript` expression is an author assertion, not runtime validation or a checked correspondence
with T. Inline types and references such as `import("@app/types").Money` must resolve in the consuming
tooling project. Representations are snapshotted per registration, so the same decoder can have
different declarations in separate registries.

`codecs.typescriptTypes()` lists known expressions, including derived arrays, for downstream tools
to compile before checking results. Tools must use the same registry as the application and handle
undeclared custom representations as unknown. Schema generation and query checking belong to
[Tenon](https://github.com/kequtech/tenon-orm), not the driver.
