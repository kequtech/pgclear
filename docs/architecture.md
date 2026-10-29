# Architecture

pgclear is one TypeScript package using Node networking, TLS, crypto and streams. It has no runtime
dependencies. Public entry points are in `src/index.ts`; internal modules are not package exports.

## Responsibilities

| Module                    | Responsibility                                                         |
| ------------------------- | ---------------------------------------------------------------------- |
| `config/`                 | URI/options validation and configuration snapshots                     |
| `protocol/`               | Framing, frontend encoding and backend message decoding                |
| `auth/`                   | Password, MD5, SCRAM and channel-binding verification                  |
| `transport/`              | Socket/TLS lifecycle, backpressure and cancellation transport          |
| `codecs/`                 | Value conversion, immutable registries and explicit parameters         |
| `query.ts`                | Value-binding tag and text/values tuples                               |
| `connection/`             | Physical connection, operation queue and protocol recovery             |
| `session/`                | Expiring handles, prepared statements and transaction/savepoint scopes |
| `pool/`                   | FIFO acquisition, capacity, leases, retirement and shutdown            |
| `listener/`               | Dedicated LISTEN connection and optional reconnect                     |
| `errors.ts`, `observe.ts` | Diagnostics and isolated observation callbacks                         |

SQL composition, schema catalog interpretation, declaration rendering, query checking, migrations,
file output and application row policies belong to consumers such as Tenon. `query` and
`queryClassic` share the same encoding and execution path.

## Ownership and recovery

A physical connection executes one operation at a time. An operation reserves its queue slot before
calling user encoders, validates/encodes before sending bytes, and settles after protocol recovery.
Decoder failures do not stop draining the server response. Malformed protocol data closes the
connection. Byte limits cover frames/results; public byte values do not borrow recycled buffers.

Lease, transaction, savepoint and prepared handles belong to an exact scope. Scope exit fences new
calls before asynchronous cleanup and never reactivates an expired handle. Savepoints reserve the
parent for their whole callback and recovery. Cleanup shares an absolute five-second budget across
statement disposal, rollback and release.

Pool capacity includes connecting and retiring sessions. Release returns only a safely idle session;
it does not reset arbitrary SQL state. A pool can establish a new connection for later work, but a
closed connection or expired handle never reconnects itself.

## Protocol operations

Ordinary queries use unnamed Parse/Bind/Describe/Execute/Sync. Describe omits Bind/Execute. Explicit
preparation creates a named statement, waits for confirmation and disposes it with its creating
scope. Scripts use the simple protocol and preserve PostgreSQL's transaction semantics.

Row streams hold one operation across demand-driven Execute/Flush batches on the unnamed portal.
Completed row streams count returned rows across all batches; the raw command tag is preserved.
Completion or early close reaches ReadyForQuery before reuse. COPY shares exclusive ownership and
bounded row/byte handoff. Input pulls run independently of backend message processing, respect write
backpressure and fence late source results. COPY output early close cancels and retires the session.

Cancellation before dispatch removes queued work. Active cancellation uses a separate transport and
retires the original session, preventing a late cancel from affecting another request. Error outcome
records observed evidence, not a guess about rollback. Lost COMMIT acknowledgement is distinct from
a confirmed COMMIT followed by connection loss. Work and cleanup failures are preserved together.

Close permanently fences admission, stops waiters/retries, drains permitted work and disposes all
owned resources within its deadline. It cannot stop arbitrary application JavaScript or prove that
a remote backend stopped executing.

## Values and tooling

Stable built-in OIDs select decoders without catalog queries. Arrays derive element decoding from
the same immutable registry; explicit array overrides win. Int8 and numeric values stay exact strings;
command counts use safe JavaScript numbers or null. Unknown OIDs remain text. Codec registrations
also supply the known TypeScript representations used by downstream tools; custom function return
types can be declared on their text codec, since erased generic types cannot be recovered at runtime.
Representation declarations belong to immutable registrations and expose a finite expression list
for downstream type checking. Input encoding remains independent of selected output decoders.

Date parameters encode as UTC text; bigint parameters remain exact decimal text. Temporal inputs
and optional output codecs use the supplied/native implementation without a runtime dependency or
global mutation. Temporal output choices remain explicit, preserving the same defaults on Node 24
and runtimes with native Temporal. JSON and PostgreSQL arrays keep explicit parameter encoders.

Each result description selects its column decoders once, including array element decoders. Object
rows copy a template of own data properties and fill values directly; array rows fill a new array.
This avoids repeated codec lookups and temporary entry arrays per row while preserving special
column names, strict UTF-8/value validation and synchronous custom codecs. Scripts select a new
decoder for each result description; streams retain it across portal batches. Compatible older
package copies can still supply registries through their original per-value decoding method.

Executors expose their immutable selected registry. Queries can choose a result registry for one
operation without mutating that default or changing parameter encoders. Borrowed catalog readers
can select default codecs on the same held session and transaction; they require no private driver
scope access or replacement connection. Catalog queries and schema rendering live in Tenon.

`identity.ts` uses versioned weak maps for compatible package copies in one realm. Parameters,
registries, query tags and errors retain their creating copy's behavior and ownership. There
is no shared scheduler or strong retention of keys. Incompatible identity contracts need new keys.

## Authentication and listeners

Password preparation follows PostgreSQL's fixed stringprep tables, mapped-input checks and original
password fallback, using native NFKC. An offline checksum-pinned generator owns the tables. SCRAM
validates server proof and channel binding; TLS verifies trust and hostname.

A listener owns its connection and reconnect task independently of query pools. Reconnect is opt-in,
re-registers fixed channels and exposes generations/gaps. It provides no replay. Observation callbacks
are isolated and not awaited. Closing stops both retries and unfinished connection attempts.

## Verification

Tests cover framed bytes, scripted server failures, real PostgreSQL workflows, packed consumers,
compile-only examples and resource disposal through natural child-process exit. Use observable
barriers rather than timing guesses. Test ownership, outcomes and cleanup through public behavior.
Pipelining, binary results and automatic catalog-driven decoding are outside the current runtime.
