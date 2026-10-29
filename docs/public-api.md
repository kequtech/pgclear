# API and usage

pgclear is an ESM PostgreSQL driver for Node.js 24+. Examples below assume an open `pool` or
`connection`; close resources when the application finishes. TypeScript declarations ship with the
package. Queries execute sequentially on each physical connection.

## Connections, pools, and ownership

```ts
import { connect, createPool } from '@kequtech/pgclear';

const pool = createPool({ connectionString: process.env.DATABASE_URL!, maxConnections: 10 });
try {
  await pool.queryClassic('SELECT 1', []);
} finally {
  await pool.close();
}

const connection = await connect(process.env.DATABASE_URL!);
try {
  await connection.queryClassic('SELECT 1', []);
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
  await lease.queryClassic('SELECT 1', []);
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
`queryClassic(text, values, options)` accepts SQL text and a separate values array; use `[]` when
there are no parameters. Both are supported on pools, connections, leases and transaction/session
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
- `rowCount`: the command count as `bigint | null`; it is not always the number of returned rows.

Rows default to objects. Duplicate column names reject; use aliases or `{ rowMode: 'array' }` to
preserve positional values. Row annotations (`queryClassic<Row>` and `sql<Row>`) are
assertions, not runtime validation. Without an annotation, field values are `unknown`.
`JSON.stringify(result)` needs an application policy for bigint counts and columns.

`describe(textOrStatement, options)` returns `{ parameterTypes, fields }` without executing the
statement. PostgreSQL still parses it and takes normal analysis locks. It does not infer nullability
or application types. `session.script(text, options)` executes unbound multi-statement SQL and returns
ordered result sets. Scripts follow PostgreSQL transaction semantics without an added atomic wrapper;
a failure rejects, and earlier effects may have committed. No automatic query or script retries occur.

## Codecs and parameters

Plain binds accept `null`, string, finite number, bigint, boolean or `Uint8Array`. Unsafe integer
numbers reject. Strings/numbers use server type inference; bigint defaults to int8, booleans to bool,
and bytes to bytea. `undefined`, plain objects, arrays and `Date` reject. Choose explicit encoding:

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

| PostgreSQL type                                                   | Default JavaScript value                  |
| ----------------------------------------------------------------- | ----------------------------------------- |
| smallint/int2, integer/int4, smallserial/serial, oid              | number                                    |
| bigint/int8, bigserial                                            | bigint                                    |
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
Query expressions use their result OID: `count(*)` produces bigint. Domains reported with an
underlying type use its decoder. Unrecognized types, including money, network addresses, ranges,
composites, bit strings and XML, stay text unless overridden.

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
`'bigint'`, `'PgArray<number>'` or `'globalThis.Uint8Array'`. JSON returns the known representation
`'unknown'`; an unfamiliar custom decoder returns `undefined`. SQL nullability, enum choices, domain
resolution and encoder input types are separate. Use the same registry as the connection.

Compatible copies of the same pgclear version in one JavaScript realm can exchange parameters,
registries, borrowed generation handles and errors. These capabilities cannot be serialized or
passed between workers; different releases are not promised to interoperate.

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
  const stream = session.stream<{ id: bigint }>('SELECT id FROM events', { batchSize: 100 });
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
`{ status: 'closed' }` without an invented result. Count iterated rows for a total: PostgreSQL's
final portal command tag can describe only the last batch. Awaiting completion without consuming
or closing may block. A transport failure rejects pending metadata, completion and iteration.

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

## Schema type generation

```ts
import { generateDefinitions } from '@kequtech/pgclear';
import { writeFile } from 'node:fs/promises';

const source = await generateDefinitions({ connection: pool, namespace: 'public' });
await writeFile('database.d.ts', source);
```

The returned source exports `Database['users']['row']`, `Database['users']['insert']` and
`Database['users']['update']`. Reads follow the selected codecs, enums become literal unions, and
JSON remains unknown. Unfamiliar custom decoder types warn and become unknown. Insert/update types
reflect defaults, nullability and generated/identity writability; JSON/arrays use explicit parameters
or encoded text. Optional undefined fields mean omission by an SQL authoring tool, not valid binds.
Relationships, indexes and constraints appear in comments, not additional row properties.

`connection` accepts a pool/session, URI or connection options. Supplied handles are borrowed;
configuration creates an owned short-lived connection. Generation uses a read-only repeatable-read
snapshot and restores local settings. `namespace` defaults to public; `excludeTables` omits named
tables, and `onWarning` receives diagnostics. `signal`/`timeoutMs` cover the whole operation.
Ordinary tables and partitioned roots are included; views, foreign tables and attached partitions
need authored types. Table types do not infer join, expression or outer-join nullability. File I/O,
freshness checks, query checking and migration coordination remain caller responsibilities.

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
