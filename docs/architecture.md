# Architecture

[Documentation](README.md) · [Development](development.md) · [Public API](public-api.md)

pgclear is one TypeScript package built on Node networking, TLS, crypto, and streams, with no runtime
dependencies. `src/index.ts` defines exports and `src/types.ts` defines the public capabilities.

## How a query runs

1. A public handle checks that its scope is active and allowed to use the session. A pool operation
   first acquires a lease; a session operation already owns its connection.
2. The connection reserves queue capacity, validates SQL/options, and encodes parameters before
   writing request bytes. User encoders run only after capacity is reserved.
3. One operation at a time sends PostgreSQL protocol messages. Ordinary queries use unnamed
   Parse/Bind/Describe/Execute/Sync with no separate preliminary Describe or catalog query.
4. A row description selects column decoders once. Rows decode using that operation's registry;
   scripts select decoders per result set and streams retain them across batches.
5. The operation settles after protocol recovery. Decoder failures still drain the response;
   malformed protocol data destroys the connection. A one-off pool operation then releases its lease.

There is no pipelining. Concurrent operations on one physical connection queue; a pool can use
separate connections for independent work.

## Module responsibilities

| Module                    | Responsibility                                                      |
| ------------------------- | ------------------------------------------------------------------- |
| `config/`                 | URI/options validation and configuration snapshots                  |
| `protocol/`               | Framing, frontend encoding, backend message decoding                |
| `auth/`                   | Password, MD5, SCRAM, and channel-binding verification              |
| `transport/`              | Socket/TLS lifecycle, backpressure, cancellation transport          |
| `codecs/`                 | Value conversion, immutable registries, explicit parameters         |
| `query.ts`                | Binding template tag and text/values tuples                         |
| `connection/`             | Physical connection, operation queue, protocol recovery             |
| `session/`                | Expiring handles, prepared statements, transaction/savepoint scopes |
| `pool/`                   | FIFO acquisition, capacity, leases, retirement, shutdown            |
| `listener/`               | Dedicated LISTEN connection and optional reconnect                  |
| `errors.ts`, `observe.ts` | Diagnostics and isolated observation callbacks                      |
| `identity.ts`             | In-process capability identity across compatible package copies     |

SQL composition, schema interpretation, declaration generation, query checking, migrations, file
output, and application row policy belong to consumers such as Tenon. `query` and `queryClassic`
share the same encoding/execution path.

## Ownership and cleanup

A physical connection owns its transport and operation queue. Every lease, transaction, or savepoint
creates a separate scope. Prepared statements belong to the exact scope that created them. Scope
exit rejects new calls before asynchronous cleanup; an expired handle is never reactivated.

Transactions and savepoints reserve the parent for their callback and recovery. Cleanup shares one
absolute five-second budget across draining work, statement disposal, rollback, and release. Work
and cleanup errors are preserved together. A callback that leaves a stream unfinished cannot commit
successfully.

Pool capacity includes connecting and retiring sessions. Release reuses only safely idle connections,
without resetting arbitrary SQL session state. The pool may replace a lost connection for later
work; existing handles never reconnect themselves.

Close rejects new work, stops waiters/retries, drains admitted work within its deadline, and disposes
owned resources. It cannot stop arbitrary application JavaScript or prove remote rollback.

## Protocol operations and recovery

Describe sends Parse/Describe/Sync without execution. Preparation creates a named statement and
waits for confirmation; scope cleanup disposes it. Scripts use the simple protocol and preserve
PostgreSQL transaction semantics.

Row streams hold one operation across demand-driven Execute/Flush portal batches. Completion and
early close reach ReadyForQuery before reuse. Fully consumed row streams count returned rows across
batches while retaining the raw server command tag.

COPY holds the execution slot with bounded byte handoff. Input pulls run independently of backend
message processing, respect write backpressure, and ignore late source results after cancellation.
Early output close cancels and retires the connection. Public byte values never borrow recycled
buffers. Frame and result limits bound wire allocations rather than total JavaScript heap use.

Before dispatch, cancellation removes queued work. Active cancellation uses a separate transport
and retires the original connection, preventing a late cancel from hitting a later request. Outcome
metadata records observed evidence rather than assuming rollback. Lost COMMIT acknowledgement is
distinct from a confirmed COMMIT followed by connection loss.

## Codecs and tooling

Stable built-in OIDs select decoders without catalog discovery. Unknown types remain text. Default
built-in arrays derive element decoding from the same registry; explicit array overrides win.
Int8/numeric outputs remain exact strings and command counts remain safe numbers or null.

Registries snapshot decoder functions and representation declarations. Executors expose their
default registry; individual queries can select another without changing input encoding. This lets
catalog readers use default codecs on an application-owned transaction/session. TypeScript
representation expressions are author assertions for downstream tools, not runtime row validation.

Date inputs encode UTC fields, bigint inputs encode exact decimal text, and Temporal inputs/codecs
use native or supplied constructors. Output representation changes remain explicit. JSON and
PostgreSQL array parameters use explicit encoders.

Object rows copy a template of own data properties and fill values directly; array rows fill a new
array. This avoids repeated codec lookup and temporary entry arrays while preserving special column
names and strict UTF-8/value validation. Compatible package copies can supply registries through
their original per-value decoding method.

`identity.ts` uses versioned weak maps so compatible package copies in one realm can exchange tagged
queries, parameters, registries, and errors. Their creating copy retains behavior and ownership.
There is no shared scheduler or strong retention of capability keys. Incompatible identity
contracts require new keys; cross-release interoperability is not a public promise.

## Authentication and listeners

Password preparation uses PostgreSQL's fixed stringprep tables, mapped-input checks, original-password
fallback, and native NFKC. An offline checksum-pinned generator owns the tables. SCRAM verifies
server proof and channel binding; TLS verifies trust and hostname.

A listener independently owns its connection, ordered membership queue, and supervision task.
Subscribe/unsubscribe commits local membership only after server acknowledgement. Optional reconnect
opens a new connection, restores acknowledged membership, then processes queued changes in order.
Queued cancellation removes the request; active cancellation retires the transport without retaining
the unacknowledged change. Connection generations expose gaps; membership changes preserve them.
It provides no replay. Observation callbacks are isolated and not awaited. Closing stops retries
and unfinished connection attempts.

## Verification

Tests cover framed bytes, scripted server failures, real PostgreSQL workflows, packed consumers,
compile-only examples, and disposal through natural subprocess exit. Test ownership, outcomes, and
cleanup through observable behavior and barriers. See [development](development.md) for commands
and [historical validation](development.md#historical-validation) for recorded artifacts.
