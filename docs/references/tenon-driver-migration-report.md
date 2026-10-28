# Tenon driver migration lessons

Report supplied by the maintainer on 2026-10-28, written by the coding agent working on Tenon after
its completed Postgres.js-to-pg migration. The report describes Postgres.js 3.4.9, pg 8.23.1, and
primarily PostgreSQL 16.15. Preserve it as authored evidence; pgclear's accepted contract lives in
[the API](../public-api.md) and [decisions](../decisions.md).

The report body below is preserved as supplied, with line endings normalized and a final newline.
Its original local Tenon source link is retained; the portable equivalent is
[Tenon's driver tests](https://github.com/kequtech/tenon-orm/blob/main/test/driver.test.ts).
See [the integration assessment](../tenon-integration.md#lessons-from-the-completed-migration)
for the adopted changes and deliberate differences.

**The biggest lesson is that a PostgreSQL driver needs to be exceptionally good at ownership, state transitions, and failure recovery.** Query syntax is the visible part. The difficult work is ensuring that a failed operation cannot corrupt another operation, a disconnected transaction cannot continue on a replacement connection, and shutdown cannot leave hidden work running indefinitely.

If I were designing a replacement, I would make those properties its foundation. Ergonomics and performance would build on them.

This report draws on our version-specific investigations of **Postgres.js 3.4.9**, **pg 8.23.1**, and Tenon’s regression tests, primarily exercised against PostgreSQL 16.15. PostgreSQL’s protocol documentation supplies the underlying requirements. Recommendations below are design judgments based on that evidence; they are not claims that every version or deployment of either existing driver behaves identically.

Both libraries have ideas worth keeping. pg offers a straightforward SQL interface and explicit connection ownership. Postgres.js offers convenient parameter binding, accessible statement description, and notification helpers. The opportunity for a new driver would be to combine that usefulness with stronger and more uniform lifecycle guarantees.

The most instructive findings were these:

| What we encountered | What it teaches |
|---|---|
| Postgres.js reserved-session work could continue after connection loss | A transaction handle must remain bound to one physical database session |
| Serialization failures interacted badly with prepared statements and pipelining | Encoding, protocol dispatch, cache state, and result ownership must be designed together |
| Postgres.js array NULL handling needed correction; pg numeric arrays could lose precision | Value conversion is a correctness contract |
| pg shutdown could leave acquisitions pending, particularly without an acquisition timeout | Shutdown must cover connections throughout their lifetime |
| Tenon’s Describe adapter initially leaked pg timeout timers | Extension APIs need clear ownership of completion and cleanup |
| Switching drivers briefly introduced extra Tenon restrictions and configuration forms | Integration layers should resist adopting incidental driver behavior as permanent product policy |

The historical session-loss and array findings also have upstream reports: [reserved transaction behavior](https://github.com/porsager/postgres/issues/1248), [array NULL conversion](https://github.com/porsager/postgres/issues/1049), and [pipeline handling of query-construction failures](https://github.com/porsager/postgres/pull/1236).

**1. A connection lease must represent one immutable database session.** This would be my first architectural rule.

A pool can replace a failed connection. A checked-out connection, transaction, cursor, advisory-lock owner, or listener must not quietly become attached to that replacement.

Once the original session dies:

- Its leases become permanently unusable.
- Its transaction and savepoints are gone.
- Its session settings and temporary objects cannot be assumed to exist.
- Its listeners require a new subscription.
- Subsequent work through the old handle must reject.

I would implement this with an explicit session identity or generation. Handles capture that identity when created. Reconnection creates a new identity and new handles.

This distinction is particularly important for transaction callbacks. JavaScript can continue executing after PostgreSQL has terminated the backend. The driver cannot cancel arbitrary application code, but it can ensure that later database calls through the expired transaction never execute.

pg’s checked-out clients were a better fit for this requirement in our investigation. We could observe failure through ordinary client events and reject late work without discovering connection IDs through debug callbacks.

I would also make reconnect and retry separate concepts. Opening a replacement connection is resource recovery. Repeating application SQL is a decision about business effects and uncertain outcomes.

**2. Every failure path must preserve result ownership.** An error belonging to request B must never be delivered to request C.

Our concurrent serialization tests were especially valuable. Three requests—valid, invalid, valid—exposed behavior that ordinary successful-query tests would miss. In our pg probe, unnamed execution preserved the expected ownership. Named statement reuse after a serialization failure could instead leave a later request failing with SQLSTATE `26000`.

A new driver should encode and validate parameters before sending protocol messages whenever possible. A JavaScript encoder exception should ideally be a local failure that leaves the wire untouched.

Where a partially dispatched operation is unavoidable, the driver needs an explicit recovery path. It must know which messages were sent, which acknowledgments arrived, and which queued operations are affected.

Prepared-statement bookkeeping should distinguish at least “being submitted” from “confirmed by the server.” Decoder caches should also account for the active codec configuration rather than indefinitely retaining an old parser function.

This needs to be one coherent operation model. Separate bits of bookkeeping for promises, named statements, pipeline positions, and connection recovery are an invitation to disagreement between those systems.

**3. Shutdown should be designed alongside connection establishment.** It becomes much harder to make reliable when added later.

A driver owns resources before a connection is available for checkout. That includes queued acquisitions, DNS work, TCP connections, TLS negotiation, authentication, initialization hooks, and reconnect timers.

Our latest Tenon tests demonstrated an important boundary: Tenon can reject an expired operation while pg is still authenticating. With pg’s default acquisition settings, the socket can remain open afterward. pg documents that its connection timeout defaults to no timeout. [pg pool configuration](https://node-postgres.com/apis/pool)

A new driver has an advantage over an ORM wrapper: it knows about connection attempts from their creation. I would give every attempt an owner immediately, with a defined path to completion, failure, cancellation, and disposal.

Its close contract should specify:

- When new work stops being accepted.
- Whether already accepted work drains.
- When queued acquisitions reject.
- What happens when the grace period expires.
- Which local resources are forcibly released.
- How late asynchronous completions are discarded.

Concurrent close calls should share one completion promise. Shutdown should become irreversible before asynchronous cleanup starts. A reconnect timer or authentication callback arriving later must not reopen a closed owner.

A forced local close should release the driver’s transports and timers and settle affected operations. Some external work—such as a user-supplied credential callback—may finish later; its result must be ignored safely.

The driver should also attempt cleanup of other owned resources when one termination request fails. We found and fixed that class of error in Tenon’s own shutdown handling.

**4. Timeouts, cancellation, and disposal need distinct meanings.** One generic timeout setting hides too many different promises.

I would distinguish these responsibilities:

| Limit or action | Intended effect |
|---|---|
| Acquisition timeout | Stop waiting for a usable connection |
| Connection deadline | Bound connection establishment, including authentication |
| Client query deadline | Bound how long the caller waits |
| Server statement timeout | Ask PostgreSQL to stop an overlong statement |
| Cancellation | Send a cancellation request for active server work |
| Forced local disposal | Release local connection resources |

All public durations should use one unit, preferably milliseconds.

An `AbortSignal` should work consistently during acquisition and execution. Aborting an acquisition should remove its waiter from the queue rather than merely rejecting a separate wrapper promise.

For active queries, cancellation needs careful connection ownership. PostgreSQL cancellation uses a separate connection and does not provide a direct acknowledgment that cancellation succeeded. The target query may already have completed. [PostgreSQL cancellation protocol](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS)

That creates another design obligation: a delayed cancellation must not accidentally affect the next operation using the same backend. I would quarantine the connection until cancellation and protocol synchronization have reached a safe boundary, or discard it when that boundary cannot be established.

Most importantly, a timeout must not be presented as proof that a write did not commit. The driver should distinguish a known server rejection from a lost connection with an unknown outcome.

**5. Pipelining and statement caching should be optional optimizations over a correct baseline.** Their combinations need more testing than their individual features.

PostgreSQL pipelines have explicit recovery boundaries. After an error, later commands can be skipped until a synchronization point, and the client must maintain the correspondence between submitted operations and returned results. [PostgreSQL pipeline behavior](https://www.postgresql.org/docs/18/libpq-pipeline-mode.html)

I would begin with unnamed extended queries and correct sequential execution. Then I would add preparation and pipelining behind the same operation model, with explicit compatibility rules for streaming, cursors, and COPY.

The minimum optimization test matrix would combine:

- Named and unnamed statements.
- Pipelining enabled and disabled.
- Local serialization failures and server SQL errors.
- Transaction and savepoint boundaries.
- Cancellation and connection loss.
- Changed codec configuration.
- Schema changes affecting prepared results.

A successful benchmark would not compensate for a failure in any of those ownership tests.

That does not make pipelining unimportant. It can substantially reduce latency for suitable workloads. It means that a driver should earn the optimization through conformance tests and representative measurements.

**6. Value codecs should favor fidelity and consistency.** Silent conversion differences are among the most expensive surprises for application maintainers.

We saw two distinct problems:

- Postgres.js needed correction to preserve SQL NULL elements in arrays.
- pg preserved large numeric scalars as strings but parsed numeric arrays into JavaScript numbers, which could lose precision.

Our pg regression demonstrates a numeric array value of `9007199254740993.25` arriving as `9007199254740994`. The behavior is recorded in Tenon’s [driver tests](/home/kequc/projects/kequtech/tenon-orm/test/driver.test.ts).

My preferred design would use one codec registry for both scalar values and array elements. NULL would be handled before calling the element codec. A numeric type would retain the same fundamental representation whether returned alone or inside an array.

I would choose conservative defaults for values that JavaScript cannot represent faithfully. For example, `bigint` and arbitrary-precision `numeric` could default to strings in both scalar and array form. Applications could explicitly select BigInt or decimal-library codecs.

Temporal values deserve similar care. PostgreSQL dates, local timestamps, instants, infinities, and precision do not fit neatly into one JavaScript `Date` representation. I would favor date-only strings for SQL `date` and make other temporal conversions explicit, with documented precision and range tradeoffs.

JSON needs its own precision decision. pg uses `JSON.parse` for JSON results, which is convenient but inherits JavaScript number representation. A new driver should make exact JSON text and parsed JSON deliberate codec choices. [pg type conversion](https://node-postgres.com/features/types)

Array dimensions and lower bounds should also be preserved or exposed when relevant. A nested JavaScript array should not be advertised as a completely lossless representation if indexing metadata has been discarded.

**7. Parameter encoding should make ambiguity explicit.** A JavaScript array can represent either a PostgreSQL array or a JSON value.

pg serializes arrays as PostgreSQL arrays and ordinarily serializes objects as JSON. Those rules are documented, but moving between drivers made their consequences particularly visible. [pg parameter conversion](https://node-postgres.com/features/queries)

For a new driver, I would provide a small explicit mechanism such as `json(value)`. It should work uniformly for objects, arrays, strings, numbers, booleans, and JSON null.

That makes these cases distinguishable:

```ts
null          // SQL NULL
json(null)    // JSON null
json("text")  // JSON string
json([1, 2])  // JSON array
[1, 2]        // PostgreSQL array, under the chosen default policy
```

Encoding helpers should be pure descriptions of bound data. They should not quietly become SQL expression objects.

For a pg-compatible replacement, I would retain undefined-to-SQL-NULL binding. Stronger input validation belongs at the application boundary. Object-to-SQL helpers may separately define undefined as omission or `DEFAULT`; that is a SQL-building contract.

This was one of our own integration lessons. Tenon briefly preserved Postgres.js-style undefined rejection after returning to pg. It added an unnecessary difference from the underlying driver.

**8. Describe should be a first-class operation.** It is valuable enough to deserve a supported API rather than an extension workaround.

PostgreSQL already separates statement description from execution. Its statement Describe response provides parameter metadata and result-column metadata before execution. [PostgreSQL Describe protocol](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY)

I would expose description on an established connection or lease, with a pool convenience method when a separate session is acceptable. That would make the choice of session explicit: callers inspecting temporary tables or transaction-local state need the existing session.

The driver should return PostgreSQL metadata directly: parameter OIDs, field names, result type OIDs, source identifiers, and format information. It should not invent nullability guarantees, JSON shapes, or application types.

Description also needs ordinary operation guarantees: deadlines, cancellation, cleanup, and correct interaction with the connection scheduler.

Our Describe timer leak is a useful example of a mistake we made. Tenon initially settled its own promise without completing through pg’s callback mechanism, leaving pg’s read-timeout timer alive. That was an integration bug in our adapter. A first-class driver operation would make that extension contract unnecessary for this core capability.

**9. Transaction behavior should follow PostgreSQL’s actual state.** A driver should expose reliable transaction mechanics while leaving application policy above it.

PostgreSQL reports whether a backend is idle, inside a transaction, or inside a failed transaction through `ReadyForQuery`. That is authoritative state the driver should understand. [PostgreSQL transaction status](https://www.postgresql.org/docs/18/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-READYFORQUERY)

An optional callback transaction helper should own one lease, expire its callback handle when finished, and verify the final transaction outcome. It must not report a successful commit when PostgreSQL returned a rollback command tag.

It should also respect successful savepoint recovery. Remembering that some earlier query failed is insufficient reason to reject a transaction that PostgreSQL has validly recovered.

There is a useful boundary here: the driver orders individual protocol operations. A higher layer such as Tenon must still serialize a logical operation consisting of several statements—for example, savepoint creation, a guarded write, and savepoint cleanup. A driver cannot infer that grouping safely from arbitrary SQL.

I would keep automatic transaction retries out of the initial driver. Retrying SQL is easier than proving that application callbacks, external effects, and uncertain commit outcomes can be repeated safely.

**10. Notifications need an honest subscription lifecycle.** Convenience is worthwhile when it exposes the important session boundaries.

Postgres.js demonstrated the appeal of a ready-made listener API. It also exposed difficult reconnect and unsubscribe behavior. pg gave us simpler explicit session ownership, with more application responsibility.

A new listener helper should own a dedicated connection, expose readiness after the subscription is effective, report disconnects, and make unsubscribe work across subscription generations.

PostgreSQL LISTEN registrations are session-specific and take effect at transaction commit. Those facts should shape the API’s readiness and reconnect semantics. [PostgreSQL LISTEN](https://www.postgresql.org/docs/18/sql-listen.html)

Reconnection must also expose that a gap occurred. The application may need to re-read durable state; the driver cannot manufacture missed notifications. PostgreSQL itself describes using notifications to signal that database state should be examined. [PostgreSQL NOTIFY](https://www.postgresql.org/docs/18/sql-notify.html)

Shutdown must own every reconnect timer and listener connection. An old retry callback must never resurrect a listener after its owner has closed.

**11. Results, errors, and diagnostics should remain straightforward.** A plain result object is a good foundation.

I would use a stable shape with separate `rows`, `rowCount`, `command`, and `fields`. Positional row mode should remain available for cases where duplicate column names cannot be represented faithfully as object properties.

I would make single-statement execution the ordinary query operation and give multi-statement scripts a clearly separate interface. The number of supplied values should not silently change the operation’s SQL execution model.

Errors should preserve SQLSTATE and useful server fields while distinguishing local encoding failures, acquisition failures, cancellation, connection loss, and server rejection. Applications should not need message matching for ordinary control flow.

For uncertain outcomes, the driver should say what it knows. “Failed before dispatch” and “connection lost after dispatch” have materially different implications.

Diagnostics should avoid embedding parameter values, credentials, or full connection strings by default. Server error details can themselves contain sensitive values, so a driver should also explain the boundary between preserving server diagnostics and safe logging.

This is another place to keep scope disciplined. Cardinality requirements and affected-row limits are useful Tenon features. They do not need to become mandatory driver policy.

**12. Streaming and COPY require real flow control.** They cannot be treated as ordinary buffered queries with a different return type.

A replacement driver should support backpressure, bounded buffering, and prompt cleanup when a consumer stops reading. It must also know when a connection is in an exclusive protocol mode.

For an initial release, unsupported combinations should fail clearly. A cursor, COPY operation, or custom protocol operation must not be allowed into a scheduler that cannot preserve its message ownership.

I would test consumer abandonment as seriously as successful consumption. Breaking out of an async iterator, rejecting a downstream stream, or aborting a COPY should leave a known connection state or cause the connection to be discarded.

Memory behavior matters alongside throughput. A driver that performs well on small buffered results may still be unsuitable for large exports or slow consumers.

**13. Public types and extension contracts are part of correctness.** Runtime capability and published declarations should be released together.

We encountered missing or incomplete declarations around useful driver features. Tenon needed local knowledge about Postgres.js notification callbacks and pg’s extended-query option.

For a new TypeScript driver, I would ship declarations from the same source and release process as the implementation, and compile representative consumers against the packed artifact.

Core features should be accessible without callers replacing socket factories, temporarily changing debug hooks, or relying on undocumented connection bookkeeping.

Where extensions are supported, completion and cleanup ownership must be explicit. A superficially flexible extension interface can be expensive if every adapter must understand how it interacts with timers, scheduler state, and disconnection.

Configuration also needs a single documented precedence model. URI fields, explicit options, environment defaults, and TLS settings can interact in surprising ways. pg’s documentation explicitly notes URI options that replace an `ssl` object. A replacement should make those effects easy to predict and test. [pg TLS configuration](https://node-postgres.com/features/ssl)

**14. The test suite should concentrate on interactions and lifetime boundaries.** Successful SELECTs are a small part of the evidence needed for a driver.

I would build a reusable conformance suite early, covering:

- A serialization failure between two valid concurrent operations.
- A lost connection between transaction statements.
- Acquisition aborted while queued, connecting, authenticating, or initializing.
- Authentication succeeding or failing after shutdown.
- Reconnect timers firing after their owner closes.
- Cancellation arriving near query completion.
- Prepared statements combined with schema or codec changes.
- NULLs, nesting, precision boundaries, and unusual array bounds.
- Protocol messages split across arbitrary network chunks.
- Streaming consumers that stop early.
- Child processes that should exit after resources are closed.

The last category caught a bug that ordinary promise assertions did not: our Describe call had returned, yet a timer kept the child process alive.

I would also use protocol fuzzing, randomized operation sequences, and controlled network interruption. The important properties are things such as “no result changes owner,” “an expired lease never executes,” and “closing cannot reopen resources.”

Performance tests should measure representative latency, memory, buffering, and connection costs, including slower networks. Local warm-pool averages would be one measurement rather than the definition of success.

Security testing needs its own coverage. Our local TLS probe established only a narrow fixture result. A production replacement would need certificate and hostname verification tests, authentication coverage, secret-handling checks, and explicit downgrade behavior. PostgreSQL’s authentication requirements are substantial enough to treat as core engineering work. [PostgreSQL password authentication](https://www.postgresql.org/docs/18/auth-password.html)

**The implementation I would start with would have a deliberately narrow public surface.** A pool would acquire leases and offer a query convenience method. A lease would execute and describe statements. Release would invalidate that lease. Close would own drainage, cancellation, and disposal.

Internally, I would separate protocol framing, session state, operation scheduling, codecs, and pool ownership. Those boundaries would be visible in the implementation without becoming a large public framework.

I would first establish correct sequential execution, session ownership, failure settlement, and shutdown. Then I would add first-class Describe and cancellation, followed by streaming and notifications. Prepared-statement caching and pipelining would follow once the conformance suite could exercise them thoroughly.

I would reuse trustworthy transport, cryptographic, and protocol components where appropriate. A cleaner driver API does not require rewriting every byte encoder or cryptographic primitive. The choice between a JavaScript implementation and a libpq binding would depend partly on deployment requirements: the former owns more protocol work, while the latter takes on native packaging and distribution concerns.

The work is feasible. The engineering commitment is substantial because a driver must remain correct across the combinations of PostgreSQL versions, authentication methods, network failures, codecs, proxies, and application lifetimes it claims to support. A small successful prototype establishes the basic query path; a dependable replacement needs much broader evidence.

The result I would want for Tenon is concrete: ordinary query execution, session acquisition, statement description, and resource closure should all be safe to delegate. Tenon would retain its SQL composition, generated types, result modes, guarded writes, and migration policy. Its driver integration would be a small boundary whose behavior is documented and tested, rather than a growing collection of repairs.
