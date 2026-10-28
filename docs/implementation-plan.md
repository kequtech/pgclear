# Implementation plan

Work in the order below. Each milestone produces a usable, verifiable slice and has an observable
completion gate. Keep this document current by recording completed gates and evidence, not by
maintaining a second backlog that can disagree with it. No driver milestone is complete yet.

## M0 — Design and project setup (this change)

Deliver canonical docs, a compiled API proposal/examples, strict TypeScript/npm foundations, private
repository onboarding, and Kequtech documentation synchronization. Verify the supplied local
`pgclear_test` connection without modifying its contents. Keep publication disabled and describe
the lack of a runtime implementation explicitly. CI runs the checks that actually exist.

Gate: `npm ci` and `npm run check` pass; initial commit is pushed to the assigned repository;
repository metadata and Actions secret presence are checked. Documentation sync success is a
separate observation, not inferred from configuration. See development.md for setup evidence.

## M1 — Protocol and one real connection

1. Move the contract to `src/` as its APIs are implemented. Make examples import the package-facing
   entry point, and keep unreleased advanced signatures clearly separated until implemented.
2. Add build output/declarations and a packed-consumer fixture; prohibit shipping declaration-only
   functions with no corresponding runtime export. Keep the package private.
3. Implement configuration parsing/validation, framing, startup, TCP/Unix sockets, verified TLS,
   trust/password/MD5/SCRAM authentication, channel binding and credential-provider deadlines.
4. Implement a sequential operation scheduler, extended query execution, immutable field metadata,
   SQLSTATE errors, loss evidence and no-value diagnostic events.
5. Introduce a real-database harness using only `PGCLEAR_TEST_DATABASE_URL`. Require an explicit
   `_test` database, verify current_database, create randomized per-test schemas/application names,
   and clean up only harness-owned objects. Never reset or drop the supplied database. Backend
   termination targets only PIDs positively observed as belonging to that test.

Gate:

- Round-trip scalar parameters and NULL on PostgreSQL 16/18; reject multi-statement extended input.
- Split/coalesce every representative frame at each byte boundary; malformed lengths, oversized
  frames and unterminated strings reject without unbounded allocation or hangs.
- Test server errors, unexpected disconnects, corrupt auth proof/nonces, Unicode password
  normalization against PostgreSQL/libpq behavior, wrong CA/hostname, and required channel binding.
- Observe zero live owned sockets/timers after startup failures and connection close.
- Packed JavaScript and TypeScript consumers import actual implemented exports.

Authentication is a real correctness/security implementation, not a hand-written sketch. Use vetted
RFC test vectors and native cryptographic primitives; add a small dependency for normalization if
native functionality cannot faithfully meet the PostgreSQL-compatible contract.

## M2 — Codecs, description and resource bounds

1. Implement scalar codecs, array text grammar, typed parameters and immutable registry composition.
   Preserve raw wire bytes internally. Resolve all encoding before request bytes are sent.
2. Add description-only dispatch and session-only multi-statement scripts.
3. Add byte/result limits, bounded per-connection queues, structured encode/decode errors and safe
   draining after decode failure. Reject duplicate object columns; exercise array mode.
4. Make buffered result lifetime independent of reusable transport buffers.

Gate:

- Exact int8/numeric values, temporal infinities, bytea, JSON numeric limitations and custom codecs
  match the documented runtime mapping; JavaScript generic assertions do not pretend to validate rows.
- Arrays cover NULL versus quoted NULL, escaped quotes/backslashes, nesting, dimension prefixes,
  delimiters and custom element types. Assert actual values, not parser implementation details.
- Description does not execute a test function that would change persistent state; confirm returned
  parameter OIDs, field origins, zero-column commands and server errors.
- Failed encoding between concurrent successful operations preserves ownership and allows later work.
- Limits reject at their boundary with all promises settled; decode failure does not corrupt the next
  result; scripts obey server transaction/error semantics and do not invent atomicity.

## M3 — Pool, leases, transactions and bounded interruption

1. Implement capacity-accounted lazy pooling, bounded FIFO waiters, expiration generations,
   withSession, release/discard, idle retirement and lifetime retirement on release.
2. Implement managed transaction/savepoint scopes, complete-operation serialization, child ownership,
   commit-tag validation, recovered SQL-error handling and preserved cleanup errors.
3. Implement AbortSignal/deadlines from invocation, pre-dispatch removal, active cancellation via a
   separate connection and mandatory retirement of canceled active connections.
4. Implement close fences, bounded draining, forced disposal, late startup cleanup and no resurrection.
5. Extend CI to a PostgreSQL 16/18 service matrix when these real integration checks exist. Keep
   packet tests database-independent. Add deterministic fake-server tests for commit-ack loss.

Gate:

- Kill a backend during/between transaction statements: late callback work rejects, no replacement
  session can receive it, and other concurrent transactions remain usable.
- Exercise cold concurrent acquisition, full queues, canceled waiters, auth failures, late password
  results, release during activity and close while connecting. Capacity never leaks or exceeds max.
- Savepoint failure recovers; sibling work cannot enter the scope; recovery failure blocks commit;
  callback handles expire before cleanup; accepted unawaited work cannot escape into another lease.
- COMMIT returning ROLLBACK fails; dropping the commit response yields COMMIT_UNKNOWN rather than
  a retry. No test equates a client timeout with rollback.
- Cancel before dispatch sends no query; active cancel cannot strike the next lease. Unsent work is
  not replayed. Cleanup failures preserve the original cause.
- Normal/error/deadline shutdown settles accepted work or rejects it, empties waiters and disposes
  owned timers/transports. Observe a bounded quiet period to prove reconnects stay stopped.

## M4 — Tenon trial and differential contract checks

Follow [Tenon integration](tenon-integration.md). Implement an adapter fixture first, using a packed
pgclear build; re-read Tenon's current migration before changing that repository. Exercise explicit
JSON/array inputs, generated value mappings, result/count metadata, description, advisory locks,
guarded writes, owned/borrowed pools and expired callbacks.

Gate: the adapted Tenon integration suite passes on PostgreSQL 16/18 with no internal transport access
or lifecycle interception. Representation changes are intentional and documented. Existing
workarounds are removed only after their regressions pass. Keep SQL composition, inspection catalog
logic, migration policy and affected-row checks in Tenon. Package publication remains separate.

This milestone is the first decision point for whether the driver is reducing total maintenance.
If it simply recreates helper complexity at the consumer boundary, fix the missing driver contract
before extending breadth.

## M5 — Explicit preparation, portals and COPY

1. Implement session-owned prepared statement handles, close ordering and lease cleanup, without
   automatic named caches/retries.
2. Implement async row iteration, metadata, bounded portal batches, explicit/early close and command
   completion distinctions. Reject competing session operations while streaming.
3. Implement COPY FROM/TO byte streams, source failures, protocol recovery and cancellation retirement.

Gate: prepared handles expire after release; stale plans surface without re-executing writes;
prepared close orders correctly with accepted executions; early stream exit permits a subsequent
query only after safe recovery; source errors and abandoned output do not strand connections;
slow consumers/producers keep buffering bounded; all completion promises settle. Verify that a
closed partial stream does not invent a final PostgreSQL command tag/count.

## M6 — Notifications and deployment compatibility

1. Implement dedicated fixed-channel listeners with stable handles, status generations, optional
   reconnect, credential refresh and permanent close fences.
2. Exercise verified TLS, Unix sockets and a pinned PgBouncer configuration in dedicated integration
   jobs. Test transaction pooling for ordinary/transaction queries; session features use direct or
   session pooling. Name the exact tested proxy version/configuration in development.md.

Gate: delivered payloads retain channel/source PID; reconnect reports a gap and re-registers channels;
original close prevents callbacks/reconnects afterward; close during backoff/setup disposes late
connections; async observer failures cannot produce unhandled rejection; no LISTEN claim is made for
transaction pooling. Changing session identity is never hidden from an exclusive session handle.

## M7 — Performance and opt-in pipelining

Measure sequential behavior first. Build reproducible small-query, large-result, typed-array/JSON,
transaction and pool-contention benchmarks with varied latency/concurrency. Compare pg and
Postgres.js under equivalent preparation/codecs, report CPU/memory and percentile latency, and retain
raw scripts/configuration. Do not encode universal speed rankings in documentation.

Then specify the pipelining option and implement bounded sent queues with one Sync boundary per
independent operation. Initially restrict it to exclusive sessions and ordinary queries. No silent
change to managed transaction semantics or one-off pool scheduling.

Gate: middle serialization/server/decoder failures, concurrent repeated preparations where supported,
cancel races, queue pressure and shutdown all preserve result ownership and settlement. Prove memory
bounds and measurable benefit in the target workloads before enabling it for any consumer. If it
fails this gate, ship the sequential release and retain the scheduler boundary for future work.

## M8 — Initial release gate

Confirm M1–M6, packed exports/declarations, standalone consumption, Tenon contract checks, clean
resource shutdown, license attribution, supported environment matrix and honest documentation.
Remove design-only declarations/examples that diverge from the actual package. Document deferred
features and any intentional API changes before selecting 0.1.0. Publishing, repository visibility
changes and a stable compatibility promise require their own explicit release instruction.

## Planning envelope and order

For one engineer, allow approximately 1–3 weeks for M1 experimentation, 6–12 weeks cumulative for
M1–M4, and 3–6 months cumulative for a credible M1–M6 release. These are uncertain effort envelopes,
not deadlines or automation schedules. Authentication, cancellation races, codec edge cases and the
Tenon value migration are the largest risks. M7 is deliberately separable from release correctness.
The next concrete implementation task is M1; do not start with benchmarks or runtime compatibility
shims while the request/session state machine is unproven.
