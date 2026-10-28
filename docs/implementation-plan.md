# Implementation plan

Work in the order below. Each milestone produces a usable, verifiable slice and has an observable
completion gate. Keep this document current by recording completed gates and evidence, not by
maintaining a second backlog that can disagree with it. M1–M6 pass the full driver check and native
TLS/Unix/PgBouncer CI on PostgreSQL 16/18 at `0d31732` (216 regression tests and three separate
compatibility tests). The refreshed local Tenon candidate passes 20 contract cases; complete
adoption and its PostgreSQL 18 consumer run remain open. M7a's measurements and profiled improvements
are complete; M7b pipelining is deferred by D33. M8 release readiness is next. See [development](development.md)
and [benchmarks](../benchmarks/README.md) for evidence. The [handoff](m5-handoff.md) is historical.

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

At that checkpoint D25 left generation, checking and SQL composition tooling in Tenon. D34 later
moves schema generation into pgclear while keeping checking and composition in Tenon.
pgclear adds only a value-binding tag and a classic text/values entrypoint through the existing
execution path. No compiler integration, generator, checker, fragments, expansion or chooser is
part of this driver plan. A future minimal codec-description contract requires a demonstrated need;
this decision does not close the outstanding M4 adoption gates. D26 records the later M5 readiness
decision separately from full Tenon adoption.

## M5 — Explicit preparation, portals and COPY

Development resumed on 2026-10-28 under D26 after the correctness follow-up. Both PostgreSQL 16/18
jobs passed for the Unicode fixes; the later query API passed 106 local tests and the 17-case
candidate trial. Its own PostgreSQL 18 result remains unverified. Full Tenon adoption remains an
independent gate. All three M5 slices and their combined review pass the full 203-test local check. See [the handoff](m5-handoff.md)
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

The cross-milestone lifecycle cleanup (D31) shares absolute deadlines, lease management and child-scope
recovery, trims derived state and moves subprocess scenarios into typed fixtures. The dispatch and
checkout boundaries explicitly reject elapsed deadlines even when timer callbacks are blocked.

Gate: prepared handles expire after release; stale plans surface without re-executing writes;
prepared close orders correctly with accepted executions; early stream exit permits a subsequent
query only after safe recovery; source errors and abandoned output do not strand connections;
slow consumers/producers keep buffering bounded; all completion promises settle. Verify that a
closed partial stream does not invent a final PostgreSQL command tag/count.

Add a named valid/invalid/valid reuse regression: a local encoding error must not make the later
valid execution fail with `26000`. Include schema/result-shape changes and distinct immutable codec
registries, checking result ownership and recovery rather than cache implementation details.

## M6 — Notifications and deployment compatibility

Implemented locally on 2026-10-28. Dedicated listeners support initial readiness, opt-in reconnect,
credential refresh, fixed-channel re-registration, gap/generation statuses and permanent close.
The implementation reuses physical startup/query/close and a shared observer isolator; it adds one
supervision task rather than reconnecting ordinary session handles.

`npm run check` passes 216 tests. The separate compatibility suite passes 3 tests on PostgreSQL
16.15 and checksum-pinned PgBouncer 1.26.1: verified native TLS/channel binding, native Unix sockets,
session features through session pooling and ordinary/transaction queries through transaction
pooling. All four PostgreSQL 16/18 driver and compatibility CI jobs passed for `0d31732` in
[run 40728530629](https://github.com/kequtech/pgclear/actions/runs/40728530629).
See [D32](decisions.md#d32--listeners-supervise-a-dedicated-connection-with-explicit-delivery-gaps)
and [reproduction](development.md#deployment-compatibility).

1. Implement dedicated fixed-channel listeners with stable handles, status generations, optional
   reconnect, credential refresh and permanent close fences.
2. Exercise verified TLS, Unix sockets and a pinned PgBouncer configuration in dedicated integration
   jobs. Test transaction pooling for ordinary/transaction queries; session features use direct or
   session pooling. Name the exact tested proxy version/configuration in development.md.

Gate: delivered payloads retain channel/source PID; reconnect reports a gap and re-registers channels;
original close prevents callbacks/reconnects afterward; close during backoff/setup disposes late
connections; async observer failures cannot produce unhandled rejection; no LISTEN claim is made for
transaction pooling. Changing session identity is never hidden from an exclusive session handle.

## M7 — Performance complete; pipelining deferred

M7a implements sequential, prepared, large-result, typed-array/JSON, transaction and pool-contention
comparisons with pinned pg/Postgres.js versions and configurable added RTT. Fresh packed-driver
workers retain individual latency samples, CPU/RSS, p50/p95/p99 and provenance; driver order rotates
between repetitions. Baseline workloads admit one operation per connection. A separate bounded
pipeline probe enables comparator pipelines while pgclear remains sequential. Reproduction,
measurement limits and results live in [benchmarks](../benchmarks/README.md). Two harness tests
cover numeric percentiles and the bounded full-duplex relay. No runtime scheduling change is made.

The first full matrix passed all 126 measurements on PostgreSQL 16.15/Node 24.4.1, with three
repetitions at 0/10 ms added RTT. Checked-in per-repetition metrics and provenance accompany the
recipe. Local prepared throughput is close to the comparators; large results and pool contention
expose CPU/throughput gaps worth profiling. The separate comparator pipeline probe demonstrates
substantial benefit for requests available ahead of time at 10 ms added RTT. It does not establish
a pgclear pipeline design or consumer adoption requirement.

The profiled follow-up is committed as `37b38df`/`990ac77`, retaining the same scheduler and public
ownership rules. Native row mapping uses one decode/entry pass, numeric readers avoid temporary
views, and ordinary packets process synchronously. Scope/lifetime cleanup avoids unobserved expiry
signals/errors and empty-drain timers. The final 219-test check, three compatibility tests,
20-case Tenon candidate trial and full 126-measurement matrix pass locally. Five longer alternating
old/new runs per workload confirm about 22% more large-result throughput and 93% more pool throughput;
CPU per operation falls about 22%/50%. See the [evidence](../benchmarks/README.md#profiled-follow-up-results).

M7b is explicitly deferred outside the first release
([D33](decisions.md#d33--defer-pipelining-and-proceed-to-release-readiness)). The benchmark probe
establishes potential benefit, but no current consumer requirement justifies the added scheduler,
recovery and maintenance cost. Add no pipeline configuration or placeholder implementation.

Reconsider only for a demonstrated consumer workload. Any future proposal must use the interaction
matrix explicitly: named/unnamed execution, pipeline on/off, local/server
errors, transaction/savepoint boundaries, cancellation/disconnects, schema changes and distinct codec
registries. Unsupported combinations must reject before dispatch; the supported subset must retain
operation ownership across failures. Repeatable seeded sequences complement specific regressions.

Future gate: middle serialization/server/decoder failures, concurrent repeated preparations where supported,
cancel races, queue pressure and shutdown all preserve result ownership and settlement. Prove memory
bounds and measurable benefit in the target workloads before enabling it for any consumer.
Sequential execution remains the release behavior until a future proposal passes this gate.

## M8 — Initial release gate

Confirm M1–M6, packed exports/declarations, standalone consumption, Tenon contract checks, clean
resource shutdown, license attribution, supported environment matrix and honest documentation.
Remove design-only declarations/examples that diverge from the actual package. Document deferred
features and any intentional API changes before selecting 0.1.0. Publishing, repository visibility
changes and a stable compatibility promise require their own explicit release instruction.

The first readiness review confirms that the packed exports/declarations have executable consumer
coverage, the license is ISC, and runtime dependencies are external packages with their own MIT
license notices. The public-API status now correctly identifies listeners as implemented.
Pipelining is now explicitly deferred, without a public option or scheduler changes.
Benchmark documentation/results, runners, comparator dependencies, trials and raw generated
artifacts remain repository-only; the package README links to the benchmark evidence on GitHub.

D34 adds the maintainer-requested generation library export during readiness. It returns
`Database[table]['row' | 'insert' | 'update']`, with relationships and indexes in comments. Generation
shares native codec registrations and read-only transaction ownership. The isolated Tenon candidate
delegates to the packed export, keeping migration locks and checking/file workflows in Tenon.
This changes generation ownership, not the remaining full consumer-adoption or 16/18 gates.

D35 resolves same-version package-copy interoperability and exposes the existing selected-codec
TypeScript mapping. A packed regression exchanges real parameters, registries, generation scopes
and errors in both directions and compiles consumer declarations. Strict SQL admission is shared
across entrypoints. The separate [SASLprep evaluation](saslprep-evaluation.md) records its remaining
authentication edge case and proposed dependency removal.

Judge adoption by reduced consumer responsibility: Tenon should delete duplicate transaction-loss
supervision, driver-internal shutdown/Describe access and default conversion tables as their
behavioral regressions pass. Preserve cardinality, guarded-write, migration and query-checking
policies in Tenon. Record the actual removed responsibilities alongside the full consumer results.
Failure tests must continue to demonstrate expiry, cleanup, cancellation isolation and accurate
write evidence. Runtime/generated types must agree under overrides, ordinary installation layouts
must work, and representative latency/CPU/memory costs must remain acceptable. Benchmark wins or
feature breadth alone do not establish these guarantees or superiority over other drivers.

Remaining work, in order:

1. Finish the applicable Tenon behavioral regression and public type-example port in the isolated
   candidate. Start with `query.test.ts`, `query-functions.test.ts`, `affected-rows.test.ts`,
   `transactions.test.ts` and `reservation.test.ts` at the pinned Tenon revision. The 20-case
   external fixture is partial coverage; the original pg baseline's 180 tests do not establish
   candidate adoption. Preserve deliberate pgclear representations and update consumer documentation.
2. Validate the full adapted consumer and current driver on PostgreSQL 16/18, including native
   TLS/Unix/PgBouncer profiles. Existing CI success at `0d31732` does not verify the newer runtime
   performance, generation and D35 interoperability changes; their checks, compatibility suites and
   consumer trials are local PostgreSQL 16.15 evidence. Keep those gates distinct.
3. Finish package/documentation consistency and attribution review, record supported/deferred
   behavior, then review 0.1.0 readiness. Keep `private: true` and version 0.0.0 during readiness;
   continue the consumer port in the isolated fixture while preserving Tenon's active checkout.

## Planning envelope and order

For one engineer, allow approximately 1–3 weeks for M1 experimentation, 6–12 weeks cumulative for
M1–M4, and 3–6 months cumulative for a credible M1–M6 release. These are uncertain effort envelopes,
not deadlines or automation schedules. Authentication, cancellation races, codec edge cases and the
Tenon value migration are the largest risks. M7 is deliberately separable from release correctness.
M3 was pushed as `a91a83b`. M4 has a local adapter trial; its full adoption gate remains open. Do not
start with benchmarks or runtime compatibility shims while the request/session state machine is
still being established.
