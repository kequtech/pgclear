# API and usage

pgclear is an ESM PostgreSQL driver for Node.js 24+. Examples below assume an open `pool` or
`connection`; close resources when the application finishes. TypeScript declarations ship with the
package. Queries execute sequentially on each physical connection.

## Connections, pools, and ownership

```ts
import { connect, createPool } from '@kequtech/pgclear';

const pool = createPool({ connectionString: process.env.DATABASE_URL!, maxConnections: 10 });
try {
  await pool.queryClassic('SELECT 1');
} finally {
  await pool.close();
}

const connection = await connect(process.env.DATABASE_URL!);
try {
  await connection.queryClassic('SELECT 1');
} finally {
  await connection.close();
}
```

`createPool` validates options synchronously and connects lazily. `connect` resolves after
successful authentication and startup. Operations start when called, without waiting to be awaited.
`pool.query` and `pool.describe` borrow a connection for one operation. Use `pool.withSession` to
hold one across several operations, or `pool.acquire` for explicit ownership:

```ts
const lease = await pool.acquire();
try {
  await lease.queryClassic('SELECT 1');
} finally {
  await lease.release();
}
```

Leases and callback handles expire permanently when released or when their callback ends. Await
work inside callbacks. `release()` drains accepted work and reuses only an idle, safely cleaned-up
connection; `release({ discard: true })` destroys it. A failed `withSession` callback discards its
connection. A managed transaction can reuse a connection after verified rollback.

Session state such as SET settings, temporary tables and advisory locks is not automatically reset.
Restore it before release or discard the lease. One-off pool queries must not leave session state.
`pool.stats` reports `total`, `idle`, `leased` and `waiting`; connecting/retiring sessions count in
`total`. Closing a pool affects only its own connections.

## Configuration

Pass a connection URI or an options object. Object fields override URI settings. Options include
`host`, `port`, `user`, `database`, `password`, `tls`, `applicationName`, `startupParameters`, `codecs`
and `onEvent`. A password may be a string or a sync/async function receiving
`{ host, port, user, database }`; the provider runs for each new connection.

The driver does not read environment variables, `.env`, service files or pgpass. Applications pass
configuration explicitly. Defaults are `localhost:5432`, the current OS user, a database with that
user's name and TLS disabled. An absolute host path selects a Unix socket directory. Connections
start with UTF8, ISO dates, ISO 8601 intervals and UTC; SQL SET commands can change temporal output.
Reserved startup keys and unknown options reject.

`tls: {}` enables certificate and hostname verification using system trust. Supply `ca`,
`cert`/`key` or `serverName` when needed. URI `sslmode=require` and `verify-full` both verify the
server; `disable` disables TLS. Other modes reject. Explicit `tls` overrides the URI setting.
Channel binding accepts `prefer` (default), `require` or `disable`; `require` needs SCRAM-PLUS.
Plaintext password authentication requires TLS or a Unix socket. Trust, password, MD5 and SCRAM
are supported; MD5 is retained for compatibility. There is no unverified TLS fallback.

| Option                | Default | Meaning                                   |
| --------------------- | ------- | ----------------------------------------- |
| `connectTimeoutMs`    | 5,000   | Connection, authentication and startup    |
| `maxQueuedOperations` | 1,000   | Unsent operations per connection          |
| `maxMessageBytes`     | 64 MiB  | Maximum incoming protocol frame           |
| `maxResultBytes`      | 64 MiB  | Buffered result bytes, including metadata |
| `maxConnections`      | 10      | Pool connection limit                     |
| `maxWaiting`          | 1,000   | Waiting pool acquisitions                 |
| `acquireTimeoutMs`    | 5,000   | Acquisition, including connection startup |
| `idleTimeoutMs`       | 30,000  | Idle retirement; 0 disables               |
| `maxLifetimeMs`       | 0       | Retirement after release; 0 disables      |

Limits are positive safe integers. Timeouts are nonnegative safe integers; 0 is an immediate
deadline except for the two retirement settings. An omitted operation timeout adds no application
deadline. Cleanup has a separate five-second bound. Frame/result overflow destroys the connection.
The result limit measures wire bytes, not JavaScript heap usage; use streaming for large results.

Direct PostgreSQL and PgBouncer session/transaction pooling are tested. Transaction pooling does
not preserve backend identity between transactions. Session locks, explicit preparation and LISTEN
need a direct or session-pooled connection; use transactions to pin a backend for transactional work.

## Query execution and results

```ts
import { sql } from '@kequtech/pgclear';

const result = await pool.queryClassic<{ value: number }>('SELECT $1::integer AS value', [42]);
const tagged = await pool.query(sql<{ value: number }>`SELECT ${42}::integer AS value`);
```

`query(taggedQuery, options)` accepts only a result created by the `sql` tag.
`queryClassic(text, values?, options?)` accepts SQL text and a separate values array, which defaults
to `[]`. For an unbound query, use `queryClassic(text)`; to supply options, use
`queryClassic(text, undefined, options)`. Both are supported on pools, connections, leases and transaction/session
callbacks. Plain text, manually constructed tuples and statement objects are rejected by `query`,
including from JavaScript. Prepared handles separately use `prepared.query(values, options)`.

`sql` returns a frozen `[text, values]` tuple. Each interpolation binds one value; it cannot insert
identifiers, SQL fragments or lists. Place interpolations outside SQL quotes/comments. Use classic
SQL for manually numbered placeholders. Bound mutable values must remain unchanged until settlement.

All query forms use the extended protocol and accept one statement. SQL must be well-formed Unicode
without NUL. Use `param(value, codec)` to supply an explicit parameter type. Describe and preparation also
accept `{ text, parameterTypes }` for OID hints without bound values. Ordinary queries perform no
preliminary Describe or catalog lookup.

A result contains:

- `rows`: a readonly array of decoded rows.
- `fields`: ordered column metadata, including name, type OID, table/column origin and wire format.
- `command`: the parsed command name, such as `SELECT`.
- `commandTag`: the server's full command tag, such as `SELECT 1`.
- `rowCount`: the command count as `number | null`; it is not always the number of returned rows.

Rows default to objects. Duplicate column names reject; use aliases or `{ rowMode: 'array' }` to
preserve positional values. Row annotations (`queryClassic<Row>` and `sql<Row>`) are
assertions, not runtime validation. Without an annotation, field values are `unknown`.
Counts above `Number.MAX_SAFE_INTEGER` reject with `PGCLEAR_RESULT_LIMIT` and retire the connection
rather than rounding. Command confirmation is preserved in the error outcome.

`describe(textOrStatement, options)` returns `{ parameterTypes, fields }` without executing the
statement. PostgreSQL still parses it and takes normal analysis locks. It does not infer nullability
or application types. `session.script(text, options)` executes unbound multi-statement SQL and returns
ordered result sets. Scripts follow PostgreSQL transaction semantics without an added atomic wrapper;
a failure rejects, and earlier effects may have committed. No automatic query or script retries occur.

## Codecs and parameters

Plain binds accept `null`, string, finite number, bigint, boolean, `Date`, supported Temporal values
or `Uint8Array`. Unsafe integer numbers reject. Strings, numbers, bigint and temporal values use
server type inference; booleans default to bool, and bytes to bytea. Bigint values encode as exact
decimal text; PostgreSQL checks the inferred destination's range. `param(value, builtin.int8)`
continues to accept exact strings and supplies an explicit int8 type. `undefined`, plain objects
and arrays reject. JSON and PostgreSQL arrays keep explicit encoding:

```ts
import { builtin, json, param } from '@kequtech/pgclear';

await pool.queryClassic('SELECT $1::jsonb, $2::integer[]', [
  json({ enabled: true }),
  param([1, null, 3], builtin.int4Array),
]);
```

`param(value, codec, format?)` supplies a PostgreSQL type and encoder. Encoding runs before dispatch;
text is preferred when available. Codecs contain an OID and complete synchronous text and/or binary
encode/decode pairs. `null` encodes SQL NULL without calling the encoder. Do not mutate bound data or
codec state before settlement. Binary parameters are supported; ordinary results use text format.

`json(value, type = 'jsonb')` uses JSON.stringify. `json(null)` means JSON null; plain `null` and
`param(null, builtin.jsonb)` mean SQL NULL. `json('text')` encodes a JSON string, not a raw document.
Cycles, bigint and values that produce no JSON text reject before dispatch.

### Date and Temporal inputs and outputs

Bind a `Date` directly when writing an instant; invalid dates reject before dispatch:

```ts
await pool.queryClassic('INSERT INTO events(occurred_at,sequence) VALUES($1,$2)', [
  new Date(),
  9007199254740993n,
]);
```

Date inputs serialize in UTC. A `timestamptz` destination preserves the instant; a `date` or
`timestamp without time zone` destination uses the UTC calendar fields. For a calendar date or
wall-clock time, prefer an ISO string or the corresponding Temporal plain type. Supported Temporal
inputs are `PlainDate`, `PlainTime`, `PlainDateTime`, `Instant`, `ZonedDateTime` and `Duration` from
native Temporal or a compatible polyfill. ZonedDateTime inputs preserve the instant without storing
the IANA zone name; calendar annotations are omitted. Durations encode as ISO intervals. Incomplete
`PlainYearMonth` and `PlainMonthDay` values require an explicit conversion or codec. PostgreSQL
applies its supported precision and range to all inputs.

Outputs remain strings by default, independently of input values and runtime Temporal availability.
For JavaScript Date output, select the instant codec explicitly:

```ts
const codecs = defaultCodecs.with(builtin.timestamptzDate);
// Pass codecs to connect/createPool. Timestamptz values and derived arrays now contain Date objects.
```

This codec returns millisecond-precision Date objects. Calendar dates and timestamps without time
zones retain their defaults. For Temporal outputs, supply native Temporal (Node 26+) or a compatible
polyfill; pgclear does not load a polyfill or change global objects:

```ts
import { createTemporalCodecs, defaultCodecs } from '@kequtech/pgclear';

const temporal = createTemporalCodecs(Temporal);
const codecs = defaultCodecs
  .with(temporal.date) // Temporal.PlainDate
  .with(temporal.timestamp) // Temporal.PlainDateTime
  .with(temporal.timestamptz) // Temporal.Instant: PostgreSQL does not retain the original zone name
  .with(temporal.time); // Temporal.PlainTime
```

Native Temporal declarations require a TypeScript library including `ESNext.Temporal`. A polyfill
can supply its own types. For example, pass `createTemporalCodecs(Temporal, {
typescriptNamespace: 'import("@js-temporal/polyfill").Temporal' })` when using that polyfill so
generated type references resolve without a global Temporal declaration. The namespace is a trusted
TypeScript expression. Date/Temporal codecs reject infinity or values outside their supported
ranges; decoder errors drain the result and preserve session recovery. Temporal codecs assume the
connection's default ISO DateStyle. Default string decoders continue to preserve those values.

### Default output representations

| PostgreSQL type                                                   | Default JavaScript value                  |
| ----------------------------------------------------------------- | ----------------------------------------- |
| smallint/int2, integer/int4, smallserial/serial, oid              | number                                    |
| bigint/int8, bigserial                                            | string                                    |
| numeric/decimal                                                   | string, including NaN/infinity spellings  |
| real/float4, double precision/float8                              | number, including NaN/infinities          |
| boolean/bool                                                      | boolean                                   |
| Text, varchar, char, name, UUID, enums                            | string                                    |
| Date, timestamp, timestamptz, time, timetz, interval              | string                                    |
| json/jsonb                                                        | JSON.parse output; TypeScript unknown     |
| bytea                                                             | Uint8Array                                |
| Supported built-in arrays                                         | Nested arrays of decoded elements or null |
| Dynamic enum/domain/extension arrays and other unrecognized types | Wire-text string                          |
| SQL NULL                                                          | null, before any decoder                  |

Temporal strings retain precision and supported infinity values without JS Date interpretation.
Query expressions use their result OID: `count(*)` produces int8, so its column value is a string.
Domains reported with an underlying type use its decoder. Unrecognized types, including money,
network addresses, ranges, composites, bit strings and XML, stay text unless overridden.

Arrays use recursive `PgArray<T>` values. Built-in parsing preserves null elements and rectangular
shape but omits lower-bound metadata. Named input codecs include `int4Array`, `int8Array`,
`numericArray` and `textArray`. Arrays may have up to six dimensions, with no undefined elements or
nested empty arrays. Dynamic array OIDs remain text; decoding does not fetch catalogs automatically.

Registries are immutable: `defaultCodecs.with(codec)` returns a new registry for the connection/pool.
Scalar overrides also affect their default built-in array decoder; an explicit array override wins.
A missing text decoder leaves text unchanged. Invalid decoded data raises `PGCLEAR_DECODE` after
protocol recovery. Typed input parameters carry their own encoders independently of the registry.

JSON numeric tokens follow JavaScript number precision, and parsed JSON null is indistinguishable
from SQL NULL. To preserve server JSON text, configure raw-text codecs:

```ts
import { defaultCodecs } from '@kequtech/pgclear';

const codecs = defaultCodecs.with(builtin.jsonText).with(builtin.jsonbText);
// Pass codecs to createPool({ connectionString, codecs }).
// Bind pre-encoded JSON with param(rawText, builtin.jsonbText).
```

`codecs.typescript(oid)` returns the known non-NULL text-result representation: for example
`'string'`, `'PgArray<number>'` or `'globalThis.Uint8Array'`. JSON returns the known representation
`'unknown'`; an unfamiliar custom decoder returns `undefined`. SQL nullability, enum choices, domain
resolution and encoder input types are separate. Use the same registry as the connection.

### Custom representations

Reuse a built-in codec when its representation fits. This example reads and writes int4 as text
instead of numbers:

```ts
import { builtin, createPool, defaultCodecs, param, type Codec } from '@kequtech/pgclear';

const int4AsText: Codec<string> = { ...builtin.text, oid: builtin.int4.oid };
const codecs = defaultCodecs.with(int4AsText);
const textPool = createPool({ connectionString: process.env.DATABASE_URL!, codecs });
try {
  const result = await textPool.queryClassic<{ id: string }>('SELECT $1 AS id', [
    param('42', int4AsText),
  ]);
  console.log(result.rows[0]?.id); // '42'
} finally {
  await textPool.close();
}
```

The pool registry selects result decoders. `param` selects an input encoder independently; a
registry override does not change plain-bind rules. SQL NULL bypasses codecs. Scalar overrides
also affect their default arrays, so int4[] becomes `PgArray<string>` here. Other pools and
`defaultCodecs` are unchanged. PostgreSQL validates encoded text against the selected database type.

Reusing the built-in text decoder also preserves its known TypeScript representation:
`codecs.typescript(23)` is `'string'`, so generated row types follow this override. A newly authored
`decode` function can declare its non-NULL output representation alongside its implementation:

```ts
const wrappedInteger: Codec<{ value: number }> = {
  oid: builtin.int4.oid,
  text: {
    encode: ({ value }) => builtin.int4.text!.encode(value),
    decode: (text) => ({ value: builtin.int4.text!.decode(text) }),
    typescript: '{ value: number }',
  },
};
const codecs = defaultCodecs.with(wrappedInteger);
// codecs.typescript(23) === '{ value: number }'
// codecs.typescript(1007) === 'PgArray<{ value: number }>'
```

Representations are snapshotted per registration, so the same decoder function may have distinct
declarations in independent registries. Explicit array overrides win. Inline type expressions and
references such as `import("@app/types").Money` resolve in the generated/checking project; that
project must provide their modules. SQL nullability is applied separately. Encoder input types and
ordinary bind rules remain independent of result representations.

`Codec<T>` checks function signatures during compilation, but T is erased at runtime. The declared
`typescript` expression is an author assertion, not runtime validation or a checked correspondence
with T. Without a declaration or recognized built-in decoder, generation still warns and uses
unknown. `codecs.typescriptTypes()` exposes the known expressions, including derived arrays, for
downstream tools to compile before checking query results. Tools must use the same configured
registry as the application. Authored query annotations remain caller assertions. All codec
functions must be synchronous; promise results reject without leaving an unhandled rejection.

### Exact integers and counts

Int8 values (including bigserial IDs and `count(*)`) are always decimal strings, including small
values such as `'1'`. This preserves the full PostgreSQL 64-bit integer range and works with
JSON.stringify without a replacer. `builtin.int8Array` uses string elements too.

Command counts are separate metadata: `rowCount` is a number or null, unaffected by codecs.
For example, this query returns one row containing a count of three:

```ts
const result = await pool.queryClassic<{ total: string }>(
  'SELECT count(*) AS total FROM generate_series(1,3)',
);
console.log(result.rows[0]?.total); // '3'
console.log(result.rowCount); // 1
const body = JSON.stringify(result);
```

Bigint inputs bind directly, even while int8 outputs remain strings. To read int8 as JavaScript
bigint, use `defaultCodecs.with(builtin.int8BigInt)`; its default array decoder follows automatically.
`builtin.int8BigIntArray` provides explicit bigint-array parameters. Both optional codecs enforce
PostgreSQL's signed 64-bit range and advertise their representations to generation/checking. Bigint
outputs require a replacer when using JSON.stringify. Converting int8 to Number can lose precision
outside JavaScript's safe integer range. Parsed JSON numeric tokens still follow JavaScript number
semantics; use the raw JSON codecs when their original numeric tokens matter.

## Transactions and savepoints

```ts
await pool.transaction(
  async (tx) => {
    await tx.queryClassic('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [10, 1]);
    await tx.savepoint(async (sp) => {
      await sp.queryClassic('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [10, 2]);
    });
  },
  { isolation: 'read committed' },
);
```

Successful callbacks commit; failures roll back. `session.transaction` requires idle state.
Options are `isolation` (`read committed`, `repeatable read`, `serializable`), `readOnly`, `deferrable`,
`signal` and `timeoutMs`. Deferrable requires serializable/read-only.

A savepoint callback owns its parent session until cleanup finishes. Use its child handle; parent
or sibling calls reject `PGCLEAR_BUSY`. Callback handles expire on exit, even if application code
continues running. Accepted work drains before commit or rollback; abandoning a stream makes a
successful callback fail and roll back. Aborts immediately expire the handle and cancel active work.

PostgreSQL transaction state governs commit: a failed transaction or a COMMIT returning ROLLBACK
is an error. Successful savepoint recovery leaves the parent usable; failed recovery poisons it.
Do not issue manual transaction boundaries inside managed callbacks. A lost COMMIT response has an
unknown outcome; retrying it automatically may duplicate work.

## Prepared statements

```ts
await pool.withSession(async (session) => {
  const prepared = await session.prepare('SELECT $1::integer AS value');
  try {
    const result = await prepared.query<{ value: number }>([42]);
  } finally {
    await prepared.close();
  }
});
```

Prepared handles expose `description`, `query(values, options)` and idempotent `close()`. They belong
to the exact session, transaction or savepoint scope that created them and expire with it. Parent
handles reject while a child scope owns the session. Scope cleanup disposes statements before reuse;
uncertain cleanup discards the connection. There is no automatic cache or retry after plan errors.

## Row streams and COPY

```ts
await pool.withSession(async (session) => {
  const stream = session.stream<{ id: string }>('SELECT id FROM events', { batchSize: 100 });
  for await (const row of stream) {
    console.log(row.id);
  }
  const completion = await stream.completion;
});
```

Streams accept tagged SQL, SQL text or `{ text, values, parameterTypes }` statements on held
sessions and transaction/savepoint handles. They expose `fields`,
`completion` and `close()`, own the execution slot, and allow one consumer. Consume or close before
running other operations. `for await` early exit awaits cleanup. The default batch size is 100;
`maxResultBytes` bounds each batch plus metadata, not the entire stream. Deadlines include consumer
waits. Manual iteration must close in a finally block if it stops early.

After consumption, completion is `{ status: 'complete', result }`; early close yields
`{ status: 'closed' }` without an invented result. For a fully consumed row result, `rowCount` is
the total rows returned across all batches, including zero; commands without a row result retain
their affected-row count or null. `commandTag` preserves PostgreSQL's raw tag, which can count only
the last portal batch. Awaiting completion without consuming or closing may block. A transport
failure rejects pending metadata, completion and iteration.

```ts
import { createReadStream } from 'node:fs';

await pool.withSession(async (session) => {
  await session.copyFrom(
    'COPY events FROM STDIN WITH (FORMAT csv)',
    createReadStream('events.csv'),
  );
  const output = session.copyTo('COPY events TO STDOUT WITH (FORMAT csv)');
  for await (const chunk of output) {
    // chunk is Uint8Array; send it to a byte destination.
  }
  await output.completion;
});
```

`copyFrom` accepts an async iterable of Uint8Array, including Node Readable byte streams, and returns
a `CommandResult`. `copyTo` returns a single-consumer byte stream with `completion` and `close()`.
Chunk boundaries are not record boundaries. CSV/binary record encoding belongs to the caller.
Input and output respect backpressure; byte limits apply to chunks/frames, not the whole transfer.
Source errors preserve their cause in `PGCLEAR_COPY_SOURCE`; invalid chunks use `PGCLEAR_ENCODE`.
Early COPY output close cancels and retires the connection. Source/iterator cleanup is bounded.

## Notifications

```ts
import { listen } from '@kequtech/pgclear';

const listener = await listen(process.env.DATABASE_URL!, {
  channels: ['jobs_changed'],
  onNotification: ({ channel, payload, backendPid }) => console.log(channel, payload, backendPid),
  reconnect: true,
});
// Elsewhere: SELECT pg_notify($1, $2) with ['jobs_changed', 'ready'].
// At shutdown:
await listener.close();
```

A listener owns a dedicated connection and resolves after registration. Channels are fixed and
quoted as identifiers. Reconnect is opt-in; status and connection generations expose delivery gaps,
which have no replay. Initial connection failure rejects rather than starting retries. Use direct
PostgreSQL or session pooling, not transaction pooling.

`timeoutMs` covers initial readiness; `signal` covers the listener lifetime. `onStatus` observes
changes. Callbacks are not awaited, provide no backpressure, and cannot alter driver outcomes;
exceptions are isolated. Closing permanently stops connections and retries.

## Schema generation migration

Pgclear 0.3.0 removes `generateDefinitions`, `GenerateOptions` and schema catalog/rendering code.
Use the schema generation API in [Tenon](https://github.com/kequtech/tenon-orm) for catalog queries,
row/insert/update declarations, schema summaries, defaults/domains/identities, application mappings
and generated-file policy. Published pgclear 0.2.0 retains its existing API.

Migrate imports of `generateDefinitions` and `GenerateOptions` to `@kequtech/tenon-orm`, and follow
Tenon's connection, namespace and output options. Tenon owns borrowing, snapshot and migration-lock
coordination. Pgclear's type registries remain the source of effective runtime representations;
there is no compatibility wrapper or dependency on Tenon inside the driver.

Tooling can inspect `executor.codecs` without acquiring another connection. A reader that needs
standard catalog values on an application-configured session can select result codecs per query:

```ts
import { defaultCodecs } from '@kequtech/pgclear';

await pool.withSession(async (session) => {
  const applicationCodecs = session.codecs;
  const result = await session.queryClassic(
    'SELECT oid,typname FROM pg_catalog.pg_type WHERE oid=$1',
    [23],
    { codecs: defaultCodecs },
  );
  // result.rows[0].oid uses default numeric decoding; session.codecs is still applicationCodecs.
});
```

`Executor.codecs` is the immutable default registry on pools, connections, leases, transactions and
savepoints. Reading it performs no acquisition or SQL and remains safe after handle expiry; query
operations continue to enforce normal lifecycle guards. `QueryOptions` and `ArrayQueryOptions`
accept `codecs` for one operation. This also applies to tagged, prepared and streamed queries;
streams retain their choice across portal batches. Scripts, Describe and COPY do not accept this
option. A registry must come from `defaultCodecs` or `.with()`; invalid registries reject before
encoding. Input encoders supplied with `param()` remain independent. Result decoder errors still
drain the owning response before subsequent operations can reuse the session.

## Deadlines, errors, and shutdown

Pass `{ signal, timeoutMs }` to bound acquisition, queued time and execution from invocation.
Transaction and session callback deadlines cover the whole scope. The earliest deadline wins;
cleanup keeps its own five-second bound. JavaScript callbacks cannot be forcibly stopped, but late
calls through expired handles reject.

`DatabaseError.code` is PostgreSQL's SQLSTATE, with structured server diagnostics. `DriverError.code`
is `PGCLEAR_*`. Errors record an `outcome`:

- `not-sent`: no request bytes were written for that operation.
- `confirmed`: a definitive command completion or server error was received; this does not imply
  the surrounding transaction committed or that row decoding succeeded.
- `unknown`: dispatch happened, but the final outcome was not observed.

A timeout/disconnect does not prove rollback. Active cancellation retires the connection so a late
cancel cannot hit later work. Lost COMMIT acknowledgement raises `PGCLEAR_COMMIT_UNKNOWN`; a confirmed
COMMIT tag establishes success even if the connection then closes. Work and cleanup errors may be
combined as `AggregateError([workError, cleanupError])`.

Expired handles reject `PGCLEAR_EXPIRED`; child-owned sessions reject parent work with `PGCLEAR_BUSY`.
Unexpected managed transaction state uses `PGCLEAR_TRANSACTION_STATE`; leaked one-off pool transaction
state uses `PGCLEAR_SESSION_STATE`. No connection, lease or prepared handle reconnects itself.

`close({ timeoutMs: 5000 })` is idempotent; the first call fixes its deadline. Close rejects new work
and pool waiters, expires callback/lease handles, drains admitted operations, then destroys remaining
transports. It waits for owned client resources, not arbitrary callbacks or proof of remote rollback.

Use `onEvent` on connection/pool options for connect, disconnect, operation timing/outcome and
database-notice events. Observer
exceptions cannot change query outcomes, and callbacks are not awaited. Events omit SQL, parameters,
credentials and cancel keys; server notices/errors may themselves contain application values.

## Compatibility

The public API is the package root's exports and declarations, together with the behavior in this
guide. Result shapes, default value representations and error codes/outcomes are part of that
contract. Internal files are not supported entry points; diagnostic message wording is not a stable
machine-readable interface.

During 0.x development, patch releases preserve compatibility within a minor release line.
Incompatible API or representation changes use a new minor version and include migration notes in
the release notes. Published versions are not replaced. This follows a deliberate pre-1.0 policy
within [Semantic Versioning](https://semver.org/). Same-version package copies in one realm may
exchange in-process capabilities; compatibility between different releases is not promised.
