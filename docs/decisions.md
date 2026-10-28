# Design decisions

Accepted on 2026-10-28. These are implementation constraints; only the M1 subset is implemented.
Amend details in place while the initial design is unimplemented; record a superseding decision for
a meaningful reversal. The engineer maintaining the project owns these decisions; no review board
or separate approval workflow is required.

## D01 — Standalone driver; Tenon is a consumer

Accept finished SQL and separate parameters. Keep schema inference, SQL fragments, migrations and
affected-row policy in Tenon. Ship as one ESM TypeScript package with declarations and Node 24 as the
initial runtime. A driver-native query builder would duplicate Tenon and enlarge the safety surface.
Other runtimes are deferred until a real consumer needs them.

## D02 — Own the protocol and lifecycle

Implement protocol framing, session state and request dispatch directly using Node primitives.
Do not wrap the full pg client or fork Postgres.js. Reusing pg-protocol was considered, but its
current DataRow parser converts fields to strings and rejects binary parser mode; the new core must
preserve wire bytes and format metadata. Owning framing adds tests and maintenance, but avoids
depending on another driver's internal lifecycle and preserves a future binary path. Use documented
PostgreSQL protocol behavior as authority. Revisit dependencies for a demonstrated need, particularly
authentication normalization; do not invent cryptographic algorithms or copy code without licenses.

## D03 — Expiring session capabilities

A connection never resurrects; a pool can replace it with a new connection. Every lease and child
scope has an expiring generation. Handle expiration precedes cleanup and physical reuse. This directly
addresses lost-transaction and stale-reservation hazards. Listener reconnect supervision is explicitly
different: a stable registration handle owns replaceable connections and reports generations/gaps.

## D04 — Explicit execution modes and preparation

Extended protocol for ordinary queries, including zero-parameter queries. Separate session-only
simple-protocol `script` for deliberate multi-statement SQL. Description without execution is public.
Named prepared statements are explicit session-owned handles, without an unbounded automatic cache
or automatic invalidation retries. This makes query cost and error ownership explainable and proxy
behavior testable. Unnamed statements still use PostgreSQL Parse/Bind/Execute; they are not a
different security model or a lack of protocol preparation.

## D05 — Loss-conscious values and scoped codecs

Default int8 to bigint, numeric and temporal values to strings, bytes to Uint8Array, and row counts
to bigint. JSON uses ordinary JSON.parse with its documented numeric limitations. Reject ambiguous
plain object/array/Date inputs; typed parameters choose JSON, PostgreSQL arrays, and custom encodings.
Codec registries are immutable and per connection/pool. Unknown text OIDs stay text; domain/extension
discovery is the consumer's responsibility. No automatic catalog fetch or mutation of shared parsers.
This intentionally differs from both existing drivers and requires explicit Tenon mapping changes.

## D06 — Sequential correctness before pipelining

The scheduler owns all operations from day one, but dispatches sequentially initially. Add bounded
opt-in pipelining only after request ownership, Sync recovery, serialization failure and cancellation
tests pass. pg 8.23.1 already supports pipelining; mere feature presence is not differentiation.
Streaming/COPY/managed scopes remain exclusive until their combinations are justified and tested.

## D07 — Cancellation retires active connections

Expose AbortSignal and operation deadlines. Before dispatch remove only that request. After dispatch,
attempt protocol cancellation on a separate connection and retire the original connection, bounded
by cleanup time. CancelRequest does not acknowledge a particular query; reusing the connection can
let a late cancellation strike its successor. Retirement sacrifices connection reuse to make that
race tractable. A future reuse optimization requires a proof and dedicated race tests. Never promise
that timing out a write means rollback, and preserve unknown COMMIT outcomes distinctly.

## D08 — Structured scopes without a SQL parser

Provide transaction/savepoint callbacks and raw exclusive sessions. Sequential managed scopes own
their operation queue, expire handles before cleanup, validate PostgreSQL state and commit tags, and
retain work/cleanup errors. Child savepoints exclude parent/sibling use to prevent rollback crossing
another operation. Allow valid manual-savepoint recovery. Do not parse arbitrary SQL to identify all
transaction control or session changes. Consumers such as Tenon can enforce additional SQL policy.
Explicit COMMIT inside a managed callback is caller misuse with unavoidable consequences.

## D09 — Explicit, bounded resources

Every acquisition queue, wire frame and buffered result has a finite default bound. Shutdown has a
deadline and a permanent no-new-work fence, disposes timers/late transports and settles requests.
Large results use backpressure through standard async iteration. Pool release checks transaction
state and preparation cleanup but does not claim to restore all session state or release arbitrary
advisory locks. Applications must clean up session state or discard the lease.

## D10 — Security and compatibility defaults are visible

Configuration is explicit; no global environment/pgpass discovery. TLS verifies certificates and
hostnames and never falls back silently. SCRAM validates proof/nonces and supports channel binding;
plaintext password authentication requires TLS or a Unix socket. Protocol 3.0 is requested until
3.2 is intentionally implemented. Structured events exclude SQL, values, passwords and cancel keys;
server diagnostic fields remain available to the caller and can contain sensitive values.

## D11 — Canonical docs before runtime publication

Root `docs/` owns accepted design and the implementation plan. Compile public signatures and examples
now; move the contract into actual source at the first implementation milestone. Keep npm publication
disabled until the release gate. Reuse the assigned private GitHub repository, shared Kequtech docs
synchronization action, and existing test database. Documentation checks do not claim runtime driver
coverage, and onboarding does not authorize a package release or visibility change.

## D12 — SASLprep tables as a focused dependency

M1 uses `@mongodb-js/saslprep` 1.6.1 instead of reproducing Unicode 3.2 character tables and bidi
rules or treating NFKC normalization alone as SASLprep. PostgreSQL falls back to the raw password
when preparation rejects it; tests compare both normalization and that fallback with PostgreSQL and
libpq. Crypto operations remain native Node functions. TLS channel binding uses the verified
certificate's signature hash (including SHA384), rather than assuming every certificate uses SHA256.
This is a concrete exception to the initial zero-runtime-dependency preference, supported by the
authentication correctness requirement.

## D13 — Buffered result limits charge row framing

`maxResultBytes` counts complete DataRow wire bytes, including the row header and each field's length
word. Counting value payloads alone gives NULL and empty values zero cost and lets their row objects
grow without consuming the budget. The limit still does not promise an exact JavaScript heap bound;
large results use streaming when that milestone is available. No extra deployment variable is added.

## Deferred decisions

These do not block the sequential core: pipelining configuration shape; binary result selection;
custom socket factories; protocol 3.2 negotiation; CommonJS; multi-host discovery; replication; public
COPY record encoders; optional custom array constructors; and detailed public partial-script errors.
Do not expose placeholder options for them. Any blocking discovery in M1/M2 should amend the affected
accepted decision and signatures before later milestones build on it.
