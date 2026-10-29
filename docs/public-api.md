# Public API

Status: M1–M6 are implemented and locally verified: connections, pools/leases, session callbacks, transactions and
savepoints, cancellation, immutable codecs, typed/JSON parameters, arrays, description, scripts, scope-owned named preparation, portal row streams, COPY byte transfer and dedicated notification listeners.
Actual exports/types live in `src/index.ts`; [api-contract.ts](api-contract.ts) imports implemented
signatures, including listeners. [api-examples.ts](api-examples.ts) compiles with
`npm run typecheck`. Queries execute sequentially per physical connection. Pipelining is deferred
outside the first release ([D33](decisions.md#d33--defer-pipelining-and-proceed-to-release-readiness)).

## Connections, pools, and ownership

```ts
import { connect, createPool } from '@kequtech/pgclear';

const pool = createPool({ connectionString: process.env.DATABASE_URL!, maxConnections: 10 });
const result = await pool.query({ text: 'SELECT $1::integer AS value', values: [42] });
await pool.close();

const connection = await connect(process.env.DATABASE_URL!);
try {
  await connection.query('SELECT 1');
} finally {
  await connection.close();
}
```

`createPool` validates configuration synchronously and opens connections lazily. `connect` resolves
only after authentication and the startup `ReadyForQuery`. Every operation starts eagerly on call;
there are no lazy promise subclasses or await-dependent dispatch rules. Invalid operation inputs
reject their returned promise. Invalid stream inputs surface through stream promises/iteration.

`pool.query` and `pool.describe` exclusively lease a connection for one operation, then release it.
`pool.withSession` holds one lease for its callback; `pool.acquire` transfers explicit release
responsibility. The callback receives no release or close method. A standalone connection owns its
transport. `pool.close` closes only its own connections; applications own pools they pass to Tenon.
`pool.stats.total` includes connecting and retiring sessions until their transports are disposed;
`waiting` counts FIFO requests not yet assigned to a session/startup attempt. Every acquisition has
a deadline, including time assigned to startup.
`withSession` discards its connection if the callback throws, since arbitrary session cleanup may
have failed; managed transactions can reuse a connection after a successful, verified rollback.

Lease release expires the public handle immediately, drains accepted work within the cleanup bound,
and returns the connection only after `ReadyForQuery` reports idle. A lease released while in a
transaction, holding an unfinished stream, or having uncertain cleanup is discarded. Release is
idempotent. `release({ discard: true })` always destroys the transport.

Leases preserve intentional PostgreSQL session state such as temp tables and SET settings. The
caller must restore that state before release, or discard. The driver cannot detect all advisory
locks, listeners, role changes, or temp objects. It does not silently run `DISCARD ALL`. One-off
pool queries must not change session state; a detected non-idle transaction status causes discard
and `PGCLEAR_SESSION_STATE`, but arbitrary session changes cannot be reliably detected.

No connection, lease, prepared handle, or transaction handle reconnects itself. A pool may create a
new physical connection for a future acquisition. Behind transaction-pooling proxies a client
connection does not imply permanent backend identity: session locks and LISTEN require direct or
session-pooled connections, and a transaction pins a backend only until it ends.

## Configuration

Pass a URI or an options object. Explicit object fields override URI fields. Empty host/database/user,
invalid port, unsupported URI options, NULs in protocol strings, and conflicting fixed startup
parameters reject before opening a socket. URI credentials and TLS keys never appear in diagnostic
events or enumerable configuration error properties. Password providers run for each new physical
connection and have the same startup deadline; late results cannot revive an abandoned connection.

The library reads no `.env`, PG environment variables, service files, or pgpass automatically.
Applications pass configuration explicitly. Local defaults: host `localhost`, port 5432, current OS
user, database equal to user, TLS disabled. An absolute host path denotes a Unix socket directory.
URI `sslmode=disable` disables TLS; `require` and `verify-full` both enable certificate and hostname
verification. Other SSL modes reject in 0.1. Explicit `tls` overrides the URI SSL setting. There is
no opportunistic fallback to cleartext or switch to unverified TLS.

`tls: {}` uses system trust and verifies the configured host; custom `ca`, client `cert`/`key`, and
`serverName` are supported. Channel binding defaults to `prefer`, `require` refuses a session without
SCRAM-SHA-256-PLUS, and `disable` explicitly opts out. Plaintext password authentication requires TLS
or Unix sockets; trust and SCRAM can be used on explicit plaintext TCP configurations. Authentication
validates server proof, nonces, algorithm selection, and a fixed SCRAM iteration ceiling.

`startupParameters` is for PostgreSQL GUC strings, not protocol options. The driver fixes UTF8 client
encoding, ISO DateStyle and ISO-8601 IntervalStyle, and initially UTC TimeZone for predictable defaults.
Driver-owned startup keys cannot be repeated or overridden. Later client-encoding changes are
validated, and temporal strings follow the server's current session settings. Protocol/user/database/replication overrides
through this map reject. Never infer TLS mode from credentials or hostname.

| Option                | Default | Meaning                                                             |
| --------------------- | ------- | ------------------------------------------------------------------- |
| `connectTimeoutMs`    | 5,000   | TCP/TLS/auth/startup, including password provider                   |
| `maxQueuedOperations` | 1,000   | Unsent operations per physical connection                           |
| `maxMessageBytes`     | 64 MiB  | Maximum inbound protocol frame, including length word               |
| `maxResultBytes`      | 64 MiB  | Buffered rows, metadata and command bytes, including framing        |
| `maxConnections`      | 10      | Query session ceiling                                               |
| `maxWaiting`          | 1,000   | Pool acquisition waiters                                            |
| `acquireTimeoutMs`    | 5,000   | Wait for an exclusive lease, including connection startup           |
| `idleTimeoutMs`       | 30,000  | Retire an idle pooled connection; 0 disables                        |
| `maxLifetimeMs`       | 0       | Optional retirement after release; never interrupts an active lease |

Counts and byte limits must be positive safe integers. Timeout values must be finite nonnegative
safe integers; 0 means immediate deadline except the two retirement settings above. Omitted operation
timeouts impose no application deadline. Resource cleanup has a separate fixed 5-second bound; a
caller deadline never disables cleanup. Inbound size violations destroy the connection. Buffered
result overflow rejects and destroys it, with outcome based on observed protocol progress. The byte
limit is not a JavaScript heap bound; streaming is the large-result API.

## Query execution and results

Use `query` with a `sql<Row>` tag, or `queryClassic<Row>(text, values, options)` with an optional
row type on the method:

```ts
import { sql } from '@kequtech/pgclear';

const tagged = await connection.query(sql<{ value: number }>`SELECT ${42}::integer AS value`);
const classic = await connection.queryClassic<{ value: number }>(
  'SELECT $1::integer AS value',
  [42],
);
```

`sql` synchronously returns a readonly `[text, values]` tuple. The tuple and its values array are
frozen; mutable bound data retains the usual immutability-until-settlement requirement. Every
interpolation produces one numbered placeholder and one bound value, without stringifying values
or invoking codecs. Interpolations must appear where PostgreSQL accepts a parameter, outside SQL
quotes/comments. Use classic text for manually numbered placeholders instead of mixing them with
tag-generated numbering. The tag supports no identifier interpolation, fragments, expansion or
chooser. JSON and arrays still require `json(...)` or `param(...)`.

`query` also accepts a classic `[text, values]` tuple, plain text, and the existing
`{ text, values, parameterTypes }` form. Existing `query<Row>` assertions remain supported for
these forms. The two named entrypoints use one encoder and the same ownership/options/result path;
`query`'s second argument is options, while `queryClassic`'s second argument is always values.
This applies to connections, pools, leases, sessions and transactions, including array row mode.

All forms use the extended protocol even without parameters. Exactly one statement is accepted;
an empty statement has an empty result and command tag. SQL text must be well-formed Unicode
without NUL, consistently across execution, Describe, preparation, scripts, streams and COPY.
Invalid text rejects locally before dispatch. No SQL composition, identifier helpers,
query builder or check command is included. Schema types are generated explicitly through
`generateDefinitions`, described below. `script(text)`
is the deliberate simple-protocol, multi-statement path, available only on an owned session.
Scripts accept no bound values and obey PostgreSQL's own transaction semantics; they do not add an
atomic wrapper. A failed script rejects with its server error; callers must not assume earlier
commands rolled back. Detailed public partial-result error context is deferred. No automatic script
retry is permitted. If decoding and a later script command both fail, an AggregateError preserves
the decode error and server error in that order.

`parameterTypes` contains OIDs, with 0 meaning server inference. When supplied to execution it must
have one entry per value. Typed `param` values fill unspecified OIDs; conflicting nonzero OIDs reject.
Description/preparation may supply parameter OIDs before values exist. There is no mandatory
catalog query or preliminary Describe round trip for an ordinary execution.

Results contain `rows`, ordered `fields`, parsed `command`, raw `commandTag`, and `rowCount` as
`bigint | null`. Preserve affected counts without unsafe integer rounding. Row count describes the
command tag, not always rows returned. Object mode rejects duplicate column names before returning
ambiguous rows; use aliases or `rowMode: 'array'` to retain duplicate fields. Object fields are own
data properties, including names such as `__proto__`. Array mode preserves ordinal order.
Because counts are bigint, `JSON.stringify(result)` requires an explicit application serialization
policy even when every returned column is JSON-compatible. The driver does not coerce exact counts.

`sql<MyRow>`, `queryClassic<MyRow>` and existing `query<MyRow>` are caller assertions; they perform
no runtime result validation or schema inference. Without a row type, values are `unknown`.
Schema generation is a pgclear library operation; intentional query checking remains in Tenon.
Streaming uses the same decoding rules. Description does not
infer nullability, resolve domains through catalog queries, or discover application TypeScript types.

Protocol UTF-8 decoding preserves leading U+FEFF in values and names. It rejects invalid UTF-8;
it does not strip byte-order marks or normalize Unicode data. Array syntax recognizes only the six
ASCII whitespace characters PostgreSQL specifies; Unicode whitespace in elements is preserved.

## Codecs and parameters

Plain values are null, strings, finite numbers, bigint, boolean, or Uint8Array. Plain strings/numbers
are serialized in text form with OID 0 unless an explicit type is supplied; bigint defaults to int8,
boolean to bool, and bytes to bytea. An integer number outside the safe integer range rejects.
`undefined`, plain objects, JS arrays and Date reject: choose their meaning explicitly.

```ts
await pool.query({
  text: 'SELECT $1::jsonb, $2::integer[]',
  values: [param({ enabled: true }, builtin.jsonb), param([1, null, 3], builtin.int4Array)],
});
```

`param` captures value, codec, and optional wire format. Encoding happens when the operation is
accepted for dispatch, before any bytes of that operation are written. Treat input objects/bytes as
immutable until settlement. Null uses the selected OID with protocol NULL, without invoking encode.
Codec functions are synchronous; registry composition snapshots their references. Keep any captured
codec state immutable. The default parameter format is text when implemented, otherwise binary.
A codec must implement at least one complete format pair. A requested missing format rejects.

`json(value, type = 'jsonb')` is a separate bound-data helper using JSON.stringify semantics. It
supports objects, arrays, strings, numbers, booleans and JSON null. It never becomes a SQL fragment.
The wrapper's payload is a JSON value, so `json(null)` encodes the non-NULL text token `null`;
plain `null` and `param(null, builtin.jsonb)` encode SQL NULL. `json('text')` encodes a JSON string,
not raw JSON source. Cycles/BigInt or a top-level value that produces no JSON text reject before
dispatch. Typed parameter descriptions and `json` serialize through the same operation-owned path.

The registry is immutable, scoped to the pool/connection; `.with(codec)` returns a new registry.
It affects decoding; typed parameters carry their own encoders. Replacing a codec for an OID does
not mutate another pool or cached metadata. Ordinary results request text in 0.1. Binary parameter
encoders are supported; binary result negotiation is deferred until covered for every selected
column, so binary-only codecs are valid for parameters but cannot decode ordinary text results.
Unknown text OIDs stay strings. A known codec with no text decoder also leaves a text result as a
string. Invalid data for an available decoder raises `PGCLEAR_DECODE`, drains to ReadyForQuery, and
does not transfer the error to another operation.

| PostgreSQL type                          | Default JavaScript representation                                         |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| int2/int4/oid                            | number                                                                    |
| int8                                     | bigint                                                                    |
| numeric                                  | string                                                                    |
| float4/float8                            | number, preserving PostgreSQL infinity/NaN values                         |
| bool                                     | boolean                                                                   |
| text/uuid/enums/unknown text OIDs        | string                                                                    |
| date/timestamp/timestamptz/time/interval | string, including infinity spellings                                      |
| json/jsonb                               | unknown after JSON.parse; numeric tokens follow JavaScript JSON semantics |
| bytea                                    | Uint8Array                                                                |
| SQL NULL                                 | null, always before a codec                                               |
| supported built-in arrays                | nested arrays of element values or null                                   |

JSON defaults do not promise arbitrary numeric precision. `builtin.jsonText` (OID 114) and
`builtin.jsonbText` (OID 3802) are string codecs: install them through the registry for raw result
text, and use `param(rawJsonText, builtin.jsonbText)` to bind pre-encoded JSON without JSON.stringify.
They preserve numeric tokens as returned by PostgreSQL; jsonb may normalize formatting and key order.
Parsed reads map SQL NULL and JSON null to the same JS null; text codecs distinguish SQL NULL from
the non-NULL string `null`. A JSON.stringify helper cannot restore precision already lost in a JS number.

Built-in array parsing distinguishes SQL NULL from quoted `"NULL"`, validates shape, handles escapes,
and uses the correct delimiter. Non-default lower bounds are consumed but not represented in JS
arrays; callers needing them select text or install a codec. Stable bootstrap array OIDs have explicit
mappings; dynamically assigned catalog, enum, domain and extension array OIDs stay text unless a
caller supplies a codec. No background catalog fetch mutates decoding behavior. Named helpers
`builtin.int4Array`, `int8Array`, `numericArray` and `textArray` accept `PgArray<T>`: ordinary nested
readonly arrays with null elements. Inputs must be rectangular, contain no undefined values and have
at most six dimensions; nested empty arrays reject. Bounds default to PostgreSQL's ordinary lower
bound of 1. No wrapper class or dimension metadata is introduced.

Built-in array decoders resolve each element through the same immutable registry as the scalar OID.
NULL is handled before the element decoder. Overriding int4 changes both int4 and its default array
decoder, independent of registry construction order. An explicit array-OID codec overrides this
derivation and need not change the scalar. Defaults preserve int8 as bigint and numeric as string
inside arrays, including `9007199254740993.25`; `builtin.numericArray` accepts string elements.
Typed input parameters still carry their chosen encoder rather than borrowing a result decoder.

`codecs.typescript(oid)` returns the known TypeScript representation of a non-NULL text result
using that registry. It shares the mapping used by schema generation:

```ts
defaultCodecs.typescript(20); // 'bigint'
defaultCodecs.typescript(1007); // 'PgArray<number>'
defaultCodecs.with(builtin.jsonbText).typescript(3802); // 'string'
```

Built-in JSON returns the string `'unknown'`, a known representation. An unrecognized custom
decoder returns `undefined`, including a built-in array derived from that decoder. Tooling must
request an application declaration or report that unresolved contract. Explicit built-in array
overrides retain their selected element type; binary-only overrides and unknown text OIDs return
`'string'`, matching actual reads. Invalid OIDs reject with `PGCLEAR_CONFIGURATION`.

The returned strings use `globalThis.Uint8Array` and pgclear's exported `PgArray<T>` where needed.
SQL NULL is separate; this API does not infer field nullability, catalog enum labels, domain base
types, JSON object shapes or encoder input types. Use the same selected registry as the connection
and a described field's `dataTypeOid`; no database access or decoder execution is performed.

Separate installations of the same pgclear version in one JavaScript realm can exchange parameters,
registries, borrowed pools/sessions and error instances. Internal versioned weak identity tables
preserve the creating copy's encoders, scope ownership and decoder representations. Deduplication
is unnecessary. This does not promise interoperability between different releases, across workers,
or through serialization. These objects remain in-process capabilities.

## Description and preparation

`describe` sends Parse + Describe(statement) + Sync and resolves after ReadyForQuery. It never
binds parameters or sends Execute. It returns parameter OIDs and field origin metadata; no row data
or schema inference. Errors remain PostgreSQL errors. Description performs parse/analysis and takes
normal server locks; it is not a zero-impact sandbox for arbitrary SQL.

Description uses the same operation ownership, settlement, deadline and cleanup path as execution.
Completion must remove its timer/listener resources on success and every failure path. Returning
metadata alone does not establish that the connection or calling process can be released.

Ordinary queries use the unnamed statement; no automatic named cache. `session.prepare` allocates a
driver-generated name and returns its description plus `query` and idempotent `close`.
`prepare` is also available within transaction and savepoint callbacks. Each handle belongs to the
exact creating scope and expires with it, even if the transport is later reused. Parent handles
(including their prepared queries and closes) reject `PGCLEAR_BUSY` while a child owns the session;
prepare through the child when needed. There is no ancestor-handle borrowing. Callback/lease cleanup
drains accepted work and closes owned names before commit, savepoint release/recovery or session
reuse. Named statements outlive PostgreSQL rollback, so rollback alone is insufficient cleanup.
Explicit close after expiry/loss is harmless; it cannot reactivate the handle. An unacknowledged
Close retires the physical session. See [D27](decisions.md#d27--prepared-statements-belong-to-their-creating-scope).
Prepared executions are ordinary queue operations. Close follows earlier accepted executions,
rejects later ones, and releases the server statement before connection reuse. On known disconnect
it only expires local state. Server plan-invalidated errors surface; the driver does not retry writes.

Preparation bookkeeping distinguishes submission from server-confirmed creation. A prepared handle
is usable only after successful Parse acknowledgement, description and ReadyForQuery. A local
parameter encoder error during later reuse leaves that confirmed statement intact; it must not
close or evict it and turn another operation into SQLSTATE `26000`.

## Transactions and savepoints

`pool.transaction` acquires a session; `session.transaction` requires idle state. Nested calls use
`transaction.savepoint`. Options are a closed set, never appended as arbitrary SQL. `deferrable`
requires serializable/read-only. All operations within a managed transaction are sequential in 0.1.

Callbacks receive expiring child handles. On return or throw, expire the callback handle, await all
accepted operations and close accepted streams, then commit or roll back. An abandoned stream is
closed and makes callback success fail with `PGCLEAR_BUSY`; it must never be silently committed.
An explicit abort/deadline instead fences queued work and cancels/destroys active work immediately.
An arbitrary JavaScript callback cannot be stopped; its later driver calls reject. Its eventual
rejection is observed internally. The connection must be made safe before it can return to the pool.

SQL errors do not become an unconditional sticky failure: PostgreSQL transaction status is
authoritative, allowing explicit manual-savepoint recovery. A failed transaction status prevents
commit. COMMIT must produce the COMMIT tag; a ROLLBACK tag is failure. Failed managed-savepoint
recovery poisons the enclosing transaction even if the caller catches its error.

A managed savepoint owns the whole child callback and cleanup. Parent/sibling operation calls while
that child is active reject `PGCLEAR_BUSY`; callers must use the child handle. Concurrent sibling
savepoints reject rather than interleave or deadlock. Outside child scopes, accepted queries queue
FIFO. Manual SQL transaction boundaries inside managed callbacks are caller misuse: pgclear does not
parse arbitrary SQL or promise to undo an explicit COMMIT issued by the caller. Tenon may enforce
stronger SQL restrictions above this layer.

## Schema type generation

`generateDefinitions(options)` returns TypeScript source. It explicitly reads PostgreSQL catalogs;
ordinary queries still perform no automatic catalog lookup or query checking.

```ts
import { createPool, generateDefinitions } from '@kequtech/pgclear';
import { writeFile } from 'node:fs/promises';

const pool = createPool(process.env.DATABASE_URL!);
try {
  const source = await generateDefinitions({ connection: pool, namespace: 'public' });
  await writeFile('database.d.ts', source);
} finally {
  await pool.close();
}
```

The generated export is `Database`. Each exact table name has `row`, `insert` and `update` shapes:
`Database['users']['row']`, `Database['users']['insert']` and `Database['users']['update']`.
Compose projections with ordinary `Pick`, indexed access and intersections. Foreign-key relations,
indexes (including expressions, INCLUDE columns and predicates), constraints and schema details
appear in comments. They do not add properties to returned rows. Comments are descriptive catalog
output, not migrations or a complete schema fingerprint.

Table types describe table values and schema mutation inputs. Joins, expressions, aggregates and
aliases can change a query's shape; outer joins can introduce nulls into otherwise required
columns. Those query-specific types remain authored/checked by the consumer. The return value is
TypeScript source to compile/import, not a dynamically inferred type for runtime SQL calls.

`connection` accepts a pgclear pool/session, a connection URI or `ConnectionOptions`. Supplied
handles are borrowed and remain usable; configuration creates an owned short-lived connection.
Generation uses a repeatable-read, read-only transaction, restoring transaction-local settings on
completion. `namespace` defaults to `public`; missing schemas fail, and empty schemas are valid.
Ordinary tables and partitioned roots are included; views, foreign tables and attached partitions
need authored types. `excludeTables` explicitly omits named tables; there are no Tenon-specific
defaults. `timeoutMs`/`signal` cover acquisition, catalog work and rendering. `onWarning` receives
diagnostics and may return a promise; thrown/rejected warnings fail generation with cleanup.

Reads use the selected codecs: integers/floats are numbers, int8 is bigint, numeric and temporal
values are strings, bytea is Uint8Array, and JSON is unknown. Known built-in arrays use recursive
`PgArray<T>` with null elements; dynamic/unregistered types retain wire text. Enums become literal
unions. Known built-in overrides are reflected; erased custom decoder return types become unknown
with a warning. Internal catalog reads use native defaults without mutating application codecs.

Insert/update fields reflect defaults, generated/identity writability and input nullability.
Writable fields accept canonical native values or explicit `Parameter`s; arrays and JSON accept
explicit parameters or authored wire text. Missing/undefined optional fields represent omission by
an SQL authoring tool. They are not valid undefined driver binds. Generated declarations contain
only types, with type-only pgclear imports when needed. File output, freshness comparison, query
checking and migration locks remain consumer responsibilities (D34).

## Deadlines, cancellation, and errors

`signal` and `timeoutMs` apply from method invocation, including acquisition, queued time, and wire
work. A transaction deadline covers the callback and commit. `withSession` bounds the whole callback.
`connectTimeoutMs` independently bounds startup. The earliest applicable deadline wins.

Before dispatch, cancellation removes the queued operation and reports `outcome: 'not-sent'`. After
dispatch, a private cancellation connection targets the recorded backend identity. CancelRequest has
no per-query acknowledgement. For 0.1, every active-operation cancellation retires the original
connection after recovery or destroys it at the cleanup bound; it is never reused for a successor
query that a late cancel might hit. Cancellation transports are bounded to one per retiring
session with a five-second cleanup deadline; they are auxiliary sockets, not additional query
sessions. Force-close disposes both the original and cancellation transports.
A timeout never means a write rolled back.

`DriverError.code` uses `PGCLEAR_*`; `DatabaseError.code` preserves SQLSTATE with structured severity,
position, constraint, table, and other diagnostics. `Outcome` is transport knowledge:

- `not-sent`: no bytes for that operation were written; for commit, the transaction still requires
  rollback/discard and earlier transactional work may already have run.
- `confirmed`: a definitive PostgreSQL command completion or error was observed. This does not mean
  that the surrounding transaction committed or that result decoding succeeded.
- `unknown`: dispatch occurred but the definitive outcome was not observed.

Lost COMMIT acknowledgement raises `PGCLEAR_COMMIT_UNKNOWN` with unknown outcome and preserves its
cause. A definitive COMMIT tag confirms commit even if the transport closes before ReadyForQuery;
the transaction succeeds and that connection is discarded. Never turn a lost response into an
ordinary retryable connection failure. Original work and cleanup errors
remain inspectable with `AggregateError([workError, cleanupError])`, in that order. Expired capabilities reject `PGCLEAR_EXPIRED`; a parent or sibling excluded by an active child
rejects `PGCLEAR_BUSY`. Invalid managed state rejects `PGCLEAR_TRANSACTION_STATE`; leaked one-off
pool transaction state rejects `PGCLEAR_SESSION_STATE`. No automatic statement or transaction retries. Database diagnostics may themselves contain values; pgclear does
not log them automatically. Telemetry excludes SQL, parameters, credentials and backend cancel keys.

## Streams, COPY, notifications, and close

`session.stream` owns the connection's execution slot until completion or awaited close. It exposes
field metadata, row iteration, and a completion promise. Fully consumed streams resolve
`{ status: 'complete', result }` with the final command tag/count; early close resolves
`{ status: 'closed' }` without inventing a command tag or total count. Batch size
defaults to 100 and accepts integers from 1 through 2,147,483,647. Only the first batch starts
eagerly; subsequent batches wait for consumer demand. `maxResultBytes` bounds each batch plus
retained metadata, rather than the total stream. `for await` early exit calls and awaits close. Competing operations reject BUSY while
the stream owns the slot. Cursor cleanup drains to a safe boundary or destroys the connection; an
open stream outside an explicit transaction uses the implicit protocol transaction until closed.
Only one consumer may iterate a stream. Unobserved metadata/completion promises have internal
rejection observers without changing the rejection delivered to callers.
Closing before field metadata arrives rejects the fields promise with PGCLEAR_ABORTED. Close itself
resolves after cleanup; protocol/transport failures reject completion and iteration. Partial close
does not establish rollback or absence of query side effects. Streams are available on sessions and
transaction/savepoint scopes; pools require `withSession` or a held lease. Prepared-statement handles
continue to expose `query` and `close`.

Completion waits until all rows have been consumed and portal cleanup receives ReadyForQuery.
The complete result retains PostgreSQL's exact final command tag and its parsed row count. For
row-returning portal commands, that count can describe only the last Execute batch (including zero
when the result ends exactly on a batch boundary). Count iterated rows for a stream-wide total.
Awaiting completion without consuming or closing a stream with buffered rows cannot make progress.
A second iterator or overlapping `next()` calls reject `PGCLEAR_BUSY`. Signal/deadline options cover
both database activity and time spent waiting for the consumer. Expiry closes unfinished streams;
a successful callback that abandons one fails `PGCLEAR_BUSY`, and managed transactions roll back.
A raw lease with an abandoned stream is discarded. See
[D28](decisions.md#d28--streaming-owns-one-scope-and-retains-native-completion-evidence) and
[D30](decisions.md#d30--exclusive-execution-needs-no-named-portal-resource-layer).

`copyFrom(text, asyncIterable)` and `copyTo(text)` stream protocol payloads. Uint8Array chunks and
Node Readable sources integrate with standard platform streams. pgclear does not encode CSV or
binary COPY records, and chunk boundaries are not record boundaries. A source error sends CopyFail
and drains; COPY OUT early exit uses cancellation and retires the connection. COPY command text is
one extended-protocol statement. Source pulls and socket writes obey backpressure.
COPY output uses the same complete/closed completion distinction as row streams.

COPY methods require a held session, transaction or savepoint; pools use `withSession` or a lease.
`copyFrom` returns a `CommandResult`, including the native bigint COPY count. `copyTo` returns a
single-consumer `CopyStream`; iteration and `completion` settle after all bytes and protocol cleanup.
Do not await completion without consuming or closing output. COPY bypasses row codecs and preserves
opaque text/CSV/binary bytes. Sources must yield Uint8Array; encoded strings and synchronous iterables
are rejected. Node Readable streams yielding Buffer are supported directly.

A source is first pulled after CopyInResponse. One producer chunk is retained at a time and split
into writes of at most 64 KiB (also respecting `maxMessageBytes`). Socket write callbacks gate further
writes and pulls. Output delivers one CopyData frame at a time; `maxMessageBytes` bounds frames and
`maxResultBytes` bounds each chunk plus protocol metadata, rather than the whole transfer. Source
chunks and source-owned Readable buffering are outside that driver budget.

Source exceptions use `PGCLEAR_COPY_SOURCE` with the original error as a cause; invalid chunks use
`PGCLEAR_ENCODE`. CopyFail uses fixed text without copying the source error into the protocol. Driver
cleanup calls iterator `return()` on incomplete sources, destroys interrupted Node Readables, and
fences late source results. Iterator-return failures aggregate with operation failures. Protocol and
iterator cleanup share a fixed five-second budget; expiry retires the connection. Source failures
can reuse the session after verified recovery. Accepted COPY FROM promises drain on callback/lease
expiry like other accepted operations, within the cleanup bound.

Operation deadlines include source and consumer waits. Active interruption sends CancelRequest;
COPY FROM also sends CopyFail/Sync to release a backend waiting for source data. COPY output early
close discards buffered/in-flight bytes, waits for cancellation cleanup and retires the transport.
It resolves only `closed`, with no invented result/count. Transport/protocol/cleanup failures reject
completion and close. A close while queued sends no COPY and leaves earlier work intact. Abandoned
COPY output makes successful callbacks fail `PGCLEAR_BUSY` and is discarded on lease release.
See [D29](decisions.md#d29--copy-shares-execution-ownership-and-separates-source-cleanup-from-protocol-recovery).

`listen(connectionOptions, { channels, onNotification, onStatus, reconnect })` owns a separate
connection, resolves after LISTEN acknowledgement, and returns one stable handle for that fixed
channel set. Channel identifiers are quoted by the driver and validated against the server's
identifier length; payloads stay strings. Close releases all registrations and stops reconnects.
Reconnect defaults to false. When enabled it uses capped exponential backoff with jitter (100 ms
initial ceiling, 30 s cap; each wait is 50–100% of that ceiling), reports gaps/generations, refreshes credentials, and never promises replay.
Close during reconnect fences late transports. The first connected generation is 1; failed
reconnection attempts preserve that generation until all channels register again. Initial setup
failure rejects `listen` after cleanup; optional retries apply after initial readiness. Notifications
during setup/re-registration gaps are not delivered. Channel lists are copied and deduplicated;
invalid/empty names reject, and UTF8 byte length is checked against the server limit before LISTEN.
LISTEN is not supported behind transaction pooling.
Send notifications on any executor with a parameterized statement such as
`{ text: 'SELECT pg_notify($1, $2)', values: ['jobs_changed', 'ready'] }`.

Listener `timeoutMs` bounds initial readiness only; its signal remains a lifetime cancellation hook.
Status is updated before callbacks. User callback exceptions are isolated and reported through a
fixed process warning that excludes callback/error contents. Callback return values are ignored;
returned promises have rejection observers but are never awaited and provide no backpressure.
The same isolation applies to `onEvent`, so observer failures cannot change write outcomes.

`close({ timeoutMs: 5000 })` is idempotent; the first call fixes the deadline and subsequent calls
share its promise. Closing rejects new work and acquisition waiters and expires lease/callback
handles immediately. Operations already admitted to the physical session drain up to the deadline;
remaining transports are destroyed. A callback cannot admit another statement after closing starts.
Close resolves after owned
client-side resources/timers are disposed, including late connection attempts. It cannot prove that
a remote backend has stopped executing or that an arbitrary application callback has returned.
No shutdown path schedules a reconnect. Force-close is not an acknowledgement of server rollback.
Cleanup failure on one owned resource never skips attempts to dispose the others. After all attempts,
unresolved disposal failures reject close through AggregateError; concurrent close callers observe
the same result. Timers and callback registrations are released through finally paths.
