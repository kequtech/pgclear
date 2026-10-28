# Implementation plan

Work in the order below. Each milestone produces a usable, verifiable slice and has an observable
completion gate. Keep this document current by recording completed gates and evidence, not by
maintaining a second backlog that can disagree with it. The M1–M3 core, M4 consumer trial and all M5
slices are implemented; complete Tenon adoption remains open. The complete M5 check passes **201
local tests**. See [development](development.md) for current and historical verification evidence.
The Unicode-fix commit `e742fbf` passed PostgreSQL 16/18 CI; this does not verify M5, whose own
PostgreSQL 18/CI results remain unverified. The [handoff](m5-handoff.md) is the historical M5 starting
brief. M6 notifications/deployment compatibility is the next implementation milestone.

## M0 — Design and project setup (this change)

Deliver canonical docs, a compiled API proposal/examples, strict TypeScript/npm foundations, private
repository onboarding, and Kequtech documentation synchronization. Verify the supplied local
`pgclear_test` connection without modifying its contents. Keep publication disabled and describe
the lack of a runtime implementation explicitly. CI runs the checks that actually exist.

Gate: `npm ci` and `npm run check` pass; initial commit is pushed to the assigned repository;
repository metadata and Actions secret presence are checked. Documentation sync success is a
separate observation, not inferred from configuration. See development.md for setup evidence.

## M1 — Protocol and one real connection

Verification gate completed on 2026-10-28 for implementation commit
[`7529693`](https://github.com/kequtech/pgclear/commit/7529693805201c242f4d67e41ae70d98d4342d9c).
Both PostgreSQL 16 and 18 jobs passed the full `npm run check` in
[CI run 40629729303](https://github.com/kequtech/pgclear/actions/runs/40629729303).
The local PostgreSQL 16 installation and supplied database were not upgraded or replaced.

Implemented on 2026-10-28: framing, configuration, startup/authentication, verified TLS and channel
binding, scalar extended queries, sequential dispatch, field metadata, structured errors, bounded
startup/close, and actual packed-consumer checks. See [development](development.md) for current
verification evidence. Later surfaces are not stubbed into runtime exports.

The normal sequential query path and scalar conversion needed for a real connection are implemented;
M2 owns custom codecs/arrays, description and scripts. Active query abort currently destroys the
socket; protocol cancellation and managed transaction outcome handling remain M3 work. The 16/18
CI matrix is introduced now because M1 already has meaningful database tests.

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

The [Tenon migration report](references/tenon-driver-migration-report.md) sharpens this milestone;
see [the assessment](tenon-integration.md#lessons-from-the-completed-migration) and decisions D14–D16.
It does not reopen the completed M1 gate or change the milestone order.

Implemented and pushed on 2026-10-28 as `e37c28b`. Its verification suite passed 63 tests (38 database-independent,
25 integration) against the supplied PostgreSQL 16 database. The packed-consumer test exercises the
seven actual runtime exports. Describe child processes exit after success/server-error/abort/timeout,
with abort listeners removed. See [development](development.md) for evidence and remaining limits.
Decisions D13 and D17 record the expanded result budget and native multidimensional input.
PostgreSQL 18 verification remains pending the implementation's CI run.

1. Implement scalar codecs, array text grammar, typed parameters and immutable registry composition.
   Derive built-in array element decoding from the scalar registry, with explicit array override
   precedence. Add `json(value)` for JSON null/primitives and raw json/jsonb text codecs. Preserve
   raw wire bytes internally. Resolve all encoding before request bytes are sent.
2. Add description-only dispatch and session-only multi-statement scripts through the ordinary
   operation settlement path, including timer and abort-listener cleanup.
3. Add byte/result limits, bounded per-connection queues, structured encode/decode errors and safe
   draining after decode failure. Reject duplicate object columns; exercise array mode.
4. Make buffered result lifetime independent of reusable transport buffers.

Gate:

- Exact int8/numeric values, temporal infinities, bytea, JSON numeric limitations and custom codecs
  match the documented runtime mapping; JavaScript generic assertions do not pretend to validate rows.
- Arrays cover NULL versus quoted NULL, escaped quotes/backslashes, nesting, dimension prefixes,
  delimiters and custom element types. Assert actual values, not parser implementation details.
- Numeric scalar/array values preserve `9007199254740993.25`; scalar codec overrides affect default
  built-in array decoding in either registration order, while explicit array codecs take precedence.
- SQL NULL, typed SQL NULL, JSON null, JSON strings/arrays/objects/primitives and raw JSON text have
  distinct, documented encoding paths. JSON serialization failure is local and cannot shift results.
- Description does not execute a test function that would change persistent state; confirm returned
  parameter OIDs, field origins, zero-column commands and server errors.
- Child processes exit after successful or failed Describe, including server-error, timeout and
  AbortSignal paths. Test timer/listener disposal in addition to promise settlement.
- Failed encoding between concurrent successful operations preserves ownership and allows later work.
- Limits reject at their boundary with all promises settled; decode failure does not corrupt the next
  result; scripts obey server transaction/error semantics and do not invent atomicity.

## M3 — Pool, leases, transactions and bounded interruption

Implemented on 2026-10-28 and pushed as `a91a83b`. Verification covers 93 tests (49 database-independent,
44 integration) against PostgreSQL 16. The existing CI matrix automatically includes the added
pool/session/transaction tests when pushed; neither PostgreSQL 16 nor 18 CI was awaited for this
work. See [development](development.md) for verification details. M4's Tenon adapter is next;
preparation, streaming, COPY and listeners remain later milestones.

1. Implement capacity-accounted lazy pooling, bounded FIFO waiters, expiration generations,
   withSession, release/discard, idle retirement and lifetime retirement on release.
2. Implement managed transaction/savepoint scopes, complete-operation serialization, child ownership,
   commit-tag validation, recovered SQL-error handling and preserved cleanup errors.
3. Implement AbortSignal/deadlines from invocation, pre-dispatch removal, active cancellation via a
   separate connection and mandatory retirement of canceled active connections.
4. Implement close fences, bounded draining, forced disposal, late startup cleanup and no resurrection.
5. Extend the existing PostgreSQL 16/18 CI matrix with transaction/pool tests. Keep packet tests
   database-independent. Add deterministic fake-server tests for commit-ack loss.

Gate:

- Kill a backend during/between transaction statements: late callback work rejects, no replacement
  session can receive it, and other concurrent transactions remain usable.
- Exercise cold concurrent acquisition, full queues, canceled waiters, auth failures, late password
  results, release during activity and close while connecting. Capacity never leaks or exceeds max.
- Close and abort while queued, in TCP/TLS negotiation, authenticating and completing initialization;
  late success/failure cannot publish a lease. One disposal failure cannot skip cleanup of other
  attempts, leases or idle transports; report collected failures after every cleanup attempt.
- Savepoint failure recovers; sibling work cannot enter the scope; recovery failure blocks commit;
  callback handles expire before cleanup; accepted unawaited work cannot escape into another lease.
- COMMIT returning ROLLBACK fails; dropping the commit response yields COMMIT_UNKNOWN rather than
  a retry. No test equates a client timeout with rollback.
- Cancel before dispatch sends no query; active cancel cannot strike the next lease. Unsent work is
  not replayed. Cleanup failures preserve the original cause.
- Normal/error/deadline shutdown settles accepted work or rejects it, empties waiters and disposes
  owned timers/transports. Observe a bounded quiet period to prove reconnects stay stopped.
- Run repeatable seeded operation sequences against ownership/settlement/expiration invariants,
  retaining the seed and sequence for failures. Use the current Node test harness.

## M4 — Tenon trial and differential contract checks

A reproducible local trial is implemented, pinned to Tenon 0.3.1 (`4d6cb97`). M3 was committed and
pushed as `a91a83b`; CI was not polled or awaited. See [trial evidence](tenon-trial.md) and D16/D20.
The maintainer explicitly permits Tenon's contracts to change, so this candidate adopts pgclear's
native defaults and strict binds. It adds no runtime compatibility layer or new upstream API.

This is a trial, not completed adoption. The original pg baseline's 180 tests remain distinct from
the candidate's adapted public-contract tests. A pgclear run of all 180 legacy tests is not claimed;
pg-specific mocks/configuration and listener cases must be ported or assigned to their relevant
feature milestones. The PostgreSQL 16/18 adoption gate below remains open.

The Tenon agent's review subsequently found leading-U+FEFF and Unicode-array-whitespace corruption.
D21 records the fixes and independent Unicode regressions; the original green trial did not cover
these values. The Unicode-fix commit subsequently passed both PostgreSQL 16/18 CI jobs. D26 resumes
focused driver development; the broader consumer-adoption gates remain open.

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
before extending breadth. A need for intentional consumer/API migration is not itself a missing
driver contract: prefer the simpler standalone design and adapt or retire compatibility-specific
tests instead of recreating pg/Postgres.js machinery merely to satisfy the baseline.

The final scope decision D25 leaves generation, checking and SQL composition tooling in Tenon.
pgclear adds only a value-binding tag and a classic text/values entrypoint through the existing
execution path. No compiler integration, generator, checker, fragments, expansion or chooser is
part of this driver plan. A future minimal codec-description contract requires a demonstrated need;
this decision does not close the outstanding M4 adoption gates. D26 records the later M5 readiness
decision separately from full Tenon adoption.

## M5 — Explicit preparation, portals and COPY

Development resumed on 2026-10-28 under D26 after the correctness follow-up. Both PostgreSQL 16/18
jobs passed for the Unicode fixes; the later query API passed 106 local tests and the 17-case
candidate trial. Its own PostgreSQL 18 result remains unverified. Full Tenon adoption remains an
independent gate. All three M5 slices and their combined review pass the full 201-test local check. See [the handoff](m5-handoff.md)
for the historical starting point.

1. **M5a implemented:** Exact-scope prepared statement handles on held sessions, transactions and
   savepoints, with FIFO Close and name disposal before scope reuse ([D27](decisions.md#d27--prepared-statements-belong-to-their-creating-scope)).
   Submission is distinct from confirmed creation; local bind failures leave confirmed statements
   intact. No automatic named caches or execution retries. Streaming and COPY remain separate slices.
2. **M5b implemented:** Single-consumer async row iteration, metadata, bounded demand-driven portal
   batches, explicit/early close and native completion evidence ([D28](decisions.md#d28--streaming-owns-one-scope-and-retains-native-completion-evidence)).
   Competing operations reject while streaming; abandoned callbacks fail and clean up before scope reuse.
3. **M5c implemented:** COPY FROM/TO byte streams, native Readable/async iterable input, source failure
   and iterator cleanup, bounded writes/output backpressure, protocol recovery and cancellation
   retirement ([D29](decisions.md#d29--copy-shares-execution-ownership-and-separates-source-cleanup-from-protocol-recovery)).

The subsequent simplification (D30) uses unnamed portals for exclusive execution, a discriminated
operation state, one bounded row/byte handoff and an ordinary async COPY source task. Scope ownership
uses one reservation and carries an absolute cleanup budget through release; `queryClassic` remains
public. Tests retain mixed lifetimes, protocol failures, packed consumers, backpressure and process
exit checks, with added manual transaction recovery and reentrant source coverage. PostgreSQL 18/CI
verification and full Tenon adoption remain separate gates.

Gate: prepared handles expire after release; stale plans surface without re-executing writes;
prepared close orders correctly with accepted executions; early stream exit permits a subsequent
query only after safe recovery; source errors and abandoned output do not strand connections;
slow consumers/producers keep buffering bounded; all completion promises settle. Verify that a
closed partial stream does not invent a final PostgreSQL command tag/count.

Add a named valid/invalid/valid reuse regression: a local encoding error must not make the later
valid execution fail with `26000`. Include schema/result-shape changes and distinct immutable codec
registries, checking result ownership and recovery rather than cache implementation details.

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

Use the report's interaction matrix explicitly: named/unnamed execution, pipeline on/off, local/server
errors, transaction/savepoint boundaries, cancellation/disconnects, schema changes and distinct codec
registries. Unsupported combinations must reject before dispatch; the supported subset must retain
operation ownership across failures. Repeatable seeded sequences complement specific regressions.

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
M3 was pushed as `a91a83b`. M4 has a local adapter trial; its full adoption gate remains open. Do not
start with benchmarks or runtime compatibility shims while the request/session state machine is
still being established.
