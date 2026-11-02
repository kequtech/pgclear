# Values and codecs

[Overview](../README.md) · [Queries](queries.md) · [Reference](reference.md)

Encoding parameters and decoding results are independent. Type annotations change neither.

## Input and output mappings

| JavaScript input         | Encoding                            |
| ------------------------ | ----------------------------------- |
| null                     | SQL NULL                            |
| string                   | Text, server type inference         |
| finite number            | Decimal text; integers must be safe |
| bigint                   | Exact decimal text                  |
| boolean                  | PostgreSQL bool                     |
| Uint8Array / Buffer      | Binary bytea                        |
| valid Date               | UTC text                            |
| supported Temporal value | ISO date/time/interval text         |

Undefined, plain objects and arrays reject; use explicit JSON/array encoders. PostgreSQL validates
ranges and textual formats. Table columns and SQL expressions usually supply parameter type context.
Use a cast or explicit parameter only when that context is missing or a conversion is intended.
Keep values and codec state unchanged until settlement.

| PostgreSQL output                         | Default value                               |
| ----------------------------------------- | ------------------------------------------- |
| int2, int4, serial, oid                   | number                                      |
| int8, bigserial, count(*)                 | exact decimal string                        |
| numeric/decimal                           | string, including special numeric spellings |
| float4/float8                             | number, including NaN/infinities            |
| bool                                      | boolean                                     |
| text, UUID, enums, temporal types         | string                                      |
| json/jsonb                                | JSON.parse result, typed unknown            |
| bytea                                     | Uint8Array                                  |
| supported built-in arrays                 | nested arrays with null elements preserved  |
| unrecognized types and dynamic array OIDs | wire-text string                            |
| SQL NULL                                  | null, bypassing the decoder                 |

The reported wire OID selects the decoder. There is no automatic catalog discovery. Money, network
addresses, ranges, composites, XML and other unknown types stay text unless registered. Domains
reported with a base OID use that base decoder. Command rowCount remains number|null independently
of codecs, and rejects unsafe counts. Converting arbitrary int8/numeric text to Number can lose
precision; use BigInt for exact integer arithmetic when needed.

## JSON and arrays

```ts
import { builtin, json, param } from '@kequtech/pgclear';

await pool.queryClassic('SELECT $1 AS data, $2 AS ids', [
  json({ enabled: true }),
  param([1, null, 3], builtin.int4Array),
]);
```

json(value,type?) defaults to jsonb and uses JSON.stringify. Plain null is SQL NULL; json(null) is
JSON null. json('text') encodes a JSON string. Cycles, bigint and values producing no JSON text reject;
normal omission of undefined object fields applies. JSON numbers use JavaScript precision, and JSON
null/SQL NULL both decode as null. Use jsonText/jsonbText result codecs to preserve numeric tokens
as text; PostgreSQL jsonb can still normalize formatting.

PostgreSQL arrays use rectangular PgArray values, at most six dimensions, with no undefined or
nested empty arrays. A top-level empty array and null elements are supported. Parsing preserves shape
but not lower bounds. Default array decoding follows its selected scalar decoder; explicit array
codecs win. Dynamic enum/domain/extension array OIDs remain text until registered.

Array encoders include int4Array (numbers), int8Array/numericArray (strings), int8BigIntArray
(bigints), textArray and uuidArray. uuidArray sends uuid[]; textArray needs an explicit ::uuid[]
cast when targeting UUIDs. PostgreSQL validates UUID syntax. Local text validation rejects NUL and
ill-formed Unicode.

## Explicit parameters and registries

`param(value,codec,format?)` attaches an OID and synchronous encoder. A codec supplies complete
text and/or binary encode/decode pairs. Text is preferred when present; an explicit format must
be implemented. Null bypasses the encoder. Encoding happens before dispatch. Binary parameters
are supported; ordinary results use text format.

```ts
import { builtin, defaultCodecs, param } from '@kequtech/pgclear';

const codecs = defaultCodecs.with(builtin.int8BigInt).with(builtin.timestamptzDate);
const result = await pool.queryClassic('SELECT $1 AS id', [param('42', builtin.int8)], {
  codecs,
});
```

with() returns a new immutable registry. Supply it on a connection/pool for defaults or on a query,
prepared query or stream for that operation. Scripts, Describe and COPY have no codec override.
Every executor exposes its default codecs without SQL, even after expiry; operations still enforce
lifetime rules. Registry objects must originate from defaultCodecs/with(), not structural imitations.

Input encoders remain those selected by each parameter. Scalar result overrides affect derived
built-in arrays; explicit array overrides win. SQL NULL bypasses decoding. Reusing a built-in decoder
preserves known metadata; new decoders need a declared representation for downstream tools.

## Dates and Temporal

Date inputs encode UTC fields. A timestamptz target preserves the instant; date/timestamp targets
use its UTC calendar fields. For calendar dates or wall time, use ISO text or Temporal plain types.
Invalid Dates reject before dispatch. Default temporal strings preserve precision and infinity.

Supported Temporal inputs are PlainDate, PlainTime, PlainDateTime, Instant, ZonedDateTime and
Duration. ZonedDateTime preserves the instant, not the IANA zone; calendar annotations are omitted.
Durations encode ISO intervals. PlainYearMonth/PlainMonthDay require an explicit conversion.
PostgreSQL applies its own precision/range limits.

`timestamptzDate` reads millisecond-precision Dates. For Temporal output, supply native or
application-installed polyfill constructors:

```ts
import { Temporal } from '@js-temporal/polyfill';
import { createTemporalCodecs, defaultCodecs } from '@kequtech/pgclear';

const temporal = createTemporalCodecs(Temporal, {
  typescriptNamespace: 'import("@js-temporal/polyfill").Temporal',
});
const codecs = defaultCodecs.with(temporal.date).with(temporal.timestamptz);
```

The date/time/timestamp/timestamptz codecs return PlainDate/PlainTime/PlainDateTime/Instant.
No polyfill is installed or global changed. Defaults stay strings regardless of runtime support.
Native metadata defaults to Temporal and needs corresponding TypeScript declarations. Date/Temporal
codecs reject infinity/out-of-range values and assume ISO DateStyle. Decoder failures preserve
causes and drain responses before recovery.

## Metadata for tools

```ts
import { builtin, defaultCodecs, type Codec } from '@kequtech/pgclear';

const wrapped: Codec<{ value: number }> = {
  oid: 23,
  text: {
    encode: ({ value }) => builtin.int4.text!.encode(value),
    decode: (text) => ({ value: builtin.int4.text!.decode(text) }),
    typescript: '{ value: number }',
  },
};
const codecs = defaultCodecs.with(wrapped);
```

CodecRegistry exposes with, isDefaultDecoder(oid), typescript(oid) and typescriptTypes(). The last
returns all known expressions including derived arrays. typescript returns a non-NULL text-result
expression: JSON's unknown is known metadata; an unidentified custom decoder returns undefined;
an unknown OID that stays text reports string. isDefaultDecoder checks actual default decoder
identity, including compatible package copies; declaring string alone does not preserve enum labels.

`text.typescript` is a trusted author declaration, snapshotted per registration. It is not runtime
validation or a proven match with Codec<T>. Imports in expressions must resolve in the consuming
tooling project. Catalog enum/domain interpretation, column types and declaration generation belong
to downstream tools such as Tenon. pgclear provides conversion facts without a compiler dependency.
