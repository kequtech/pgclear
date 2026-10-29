# Development and setup

## Current project state

The repository is `git@github.com:kequtech/pgclear.git`, private, with `main` as the default
branch. The package is `@kequtech/pgclear`, unpublished and protected by `private: true`. The stable
Kequtech source identity is `pgclear`. Node.js 24+, npm, TypeScript and Prettier are the tooling
foundations. There are no runtime dependencies. Native Node modules handle networking, TLS and
cryptography; fixed generated stringprep tables preserve PostgreSQL's password preparation rules.

```sh
npm ci
npm run check
```

`npm run check` checks formatting, strict types, protocol/authentication tests, external packed
JavaScript/TypeScript consumers, and real PostgreSQL integration tests. Set the test database first.
`npm run format` applies formatting. Build and test compilation remove old output before compiling.

| Command                    | Scope                                                                 |
| -------------------------- | --------------------------------------------------------------------- |
| `npm run build`            | Actual JS, declarations and maps in dist/                             |
| `npm run typecheck`        | Implemented source, tests and accepted design examples                |
| `npm run test:unit`        | Packet/auth/config/fake-server and packed-consumer tests; no database |
| `npm run test:integration` | Supplied `_test` database, including PostgreSQL/libpq auth comparison |
| `npm test`                 | Both test groups                                                      |
| `npm run benchmark`        | Isolated comparator workers against the configured `_test` database   |

Fake-server tests require loopback/Unix sockets. Integration tests require `psql`; packed-consumer
tests use `tar` and reuse only runtime dependencies declared in the packed manifest. TLS fixtures
are explicitly public test-only keys/certificates. The package remains private; `npm pack` exercises
distribution locally and does not publish it. The runtime exports are `connect`, `createPool`, `DriverError`, `DatabaseError`, `builtin`, `defaultCodecs`, `param`,
`json`, `sql`, `listen` and `generateDefinitions`.

The M8 package audit keeps the ISC license, ESM exports, declarations and `private: true`. PostgreSQL
attribution for the generated stringprep tables and preparation rules is included in LICENSE.
Regenerate those tables with `node scripts/generate-saslprep.mjs /path/to/saslprep.c`; the script
verifies the source SHA256 and does not run during installation or application execution. Benchmark
documentation/results, runners, comparator dependencies, trials and raw generated artifacts remain
repository-only. The package README points to the benchmark evidence on GitHub.
See [M8](implementation-plan.md#m8--initial-release-gate) for the remaining adoption and release decisions.

## Current verification and limits

Validated runtime revision: `52a587e37ffd49e5f0d6e63562f4fbf2e975a8b1`, with a clean working tree.
PostgreSQL 16.15 and 18.0 runs used the identical packed driver artifact, SHA256
`dc9380e9dbf0b876ed052f6ebf5e4dfa2265ab3c0fe71054c2ad97f8ff40beaf`.
[Machine-readable evidence](validation-2026-10-29.json) records the exact suites and consumer pin.

| Local PostgreSQL | Driver tests | Native compatibility | Adapted Tenon | Packed candidate contracts | Original pg baseline |
| ---------------- | ------------ | -------------------- | ------------- | -------------------------- | -------------------- |
| 16.15            | 232          | 3                    | 180           | 20                         | 180                  |
| 18.0             | 232          | 3                    | 180           | 20                         | 180                  |

All listed tests passed without skips. The additional baseline contract fixture passes 15 cases
and skips five candidate-only features. The full candidate includes the original 180 adapted
regressions, packed production consumers, CLI workflows and TypeScript 6/7 contracts. This closes
the previous partial-consumer and current-runtime local matrix gaps. It does not publish either
package, modify Tenon's active checkout or claim a new GitHub CI run.

D36 removes all runtime dependencies. Twenty credential cases compare PostgreSQL/libpq behavior;
a corpus also compares native NFKC for every changing stringprep-assigned character. The disposable
PostgreSQL 18.0 build was checked against the official archive SHA256; its fixture uses the normal
100-connection PostgreSQL default to accommodate concurrent consumer files. The configured
PostgreSQL 16 installation was preserved. Native compatibility covers TLS/SCRAM-PLUS, Unix sockets
and pinned PgBouncer 1.26.1 session/transaction profiles.

The benchmark regression check uses the same committed artifact, three samples, 1,000 iterations
and 0 ms added RTT. Retained [results](../benchmarks/results/adoption-2026-10-29.json) show no material
regression against the prior matching local samples; the benchmark README explains measurement
limits. Higher-latency profiles were not repeated in this check.

Historical verification follows.

D35's package-identity and representation changes pass `npm run check`: **231 tests** (123
database-independent, 108 integration) on local PostgreSQL 16.15, plus three native compatibility
workflows. The packed two-installation regression exchanges parameters, registries, borrowed
generation scopes and errors in both directions; it checks expiry/deadlines, actual decoder values,
unknown custom representations and compiled consumer declarations. Malformed SQL is rejected
before dispatch through query/classic/tuple/object, Describe, preparation, script, stream and COPY.

The refreshed packed trial `.trial-dist/tenon-m4-PdEsod/report.json` passes the original pg baseline's
180 tests, 15 baseline contract cases (five skips), and all 20 candidate cases, including generated
types under TypeScript 6/7. Candidate query inspection now uses `defaultCodecs.typescript(oid)` and
deletes its duplicate conversion-table module. Its separate inspection connection uses defaults;
this does not describe arbitrary borrowed custom registries. At that stage neither the full adapted
Tenon suite nor a current PostgreSQL 18 run was claimed. The [SASLprep evaluation](saslprep-evaluation.md)
records the separately confirmed Unicode password limitation and its subsequent resolution in D36.

D34's schema-generation export passes `npm run check`: **228 tests** (122 database-independent,
106 integration) on local PostgreSQL 16.15. The separate native compatibility suite passes three
tests. Generated `Database[table]` row/insert/update consumers compile against actual native values;
coverage includes defaults/identity/generated columns, domains, arrays, enums, dynamic wire-text
types, relationship/index comments, hostile names, custom codecs, settings restoration, owned
cleanup and queued/active cancellation. No runtime dependency or compiler integration is added.

The packed Tenon trial `.trial-dist/tenon-m4-QHPqtq/report.json` passes the original pg baseline's
180 tests, 15 shared baseline cases (five candidate-only skips), and all 20 candidate cases. The
candidate delegates generation to pgclear and compiles `Database['models']['row']` with Tenon's
typed SQL under TypeScript 6/7. Its three old generation modules are removed; checking and
migration coordination stay in Tenon. This is local evidence, not full consumer adoption or a new
PostgreSQL 18 CI result.

M6 on 2026-10-28 passed `npm run check`: **216 tests** (118 database-independent, 98 integration)
against the existing `pgclear_test` database. A separate `npm run test:compat` passed **3 compatibility
tests** on disposable PostgreSQL 16.15 and PgBouncer 1.26.1 fixtures. All 203 previous tests remain.

Listener coverage includes real commit/rollback notification delivery, quoted/Unicode channels and
payloads, sender PID, identifier byte limits, immutable channel/status snapshots, reconnect
generations, credential refresh, failed re-registration, malformed notifications, timeout/abort,
close during backoff/authentication, late password results and callback-triggered shutdown. Three
subprocess scenarios retain natural-exit and long-timer/listener checks and prove synchronous/async
callback failures remain isolated. Packed JS/TS consumers exercise the real listener export/types.
The M6 checkpoint `0d31732` was pushed and all four jobs in
[run 40728530629](https://github.com/kequtech/pgclear/actions/runs/40728530629) passed: the full driver
check and native TLS/Unix/PgBouncer compatibility, each on PostgreSQL 16 and 18. PostgreSQL 18 ran
in CI; the local installation remains PostgreSQL 16.15. Publication, production performance and
full Tenon adoption remain separate gates.

The refreshed packed Tenon trial passed the original pg baseline's 180 tests, all 20 candidate
contract cases and the 15 shared baseline cases (five candidate-only skips). Candidate declarations
and generated types passed TypeScript 6/7. Its report is
`.trial-dist/tenon-m4-6qtkCb/report.json`. New cases exercise native preparation, streaming, COPY,
savepoint recovery and dedicated listener reconnection alongside ORM operations. This is a local
PostgreSQL 16.15 consumer trial, distinct from driver CI and complete Tenon adoption.

M7a adds isolated, pinned pg/Postgres.js comparisons without changing runtime dependencies or
enabling pipelines in pgclear. See [benchmark reproduction and results](../benchmarks/README.md).
The current local `npm run check` passes **218 tests** (120 database-independent, 98 integration),
including the harness's two percentile/relay tests. This newer tooling/fixture change has local
validation; the CI result above applies to the M6 checkpoint.
The full benchmark matrix passed 126 measurements with three repetitions at 0/10 ms added RTT;
per-repetition metrics and provenance are checked in under `benchmarks/results/`. Individual latency
arrays remain in ignored `.benchmark-dist/run-o9qK8H/` in the producing checkout.

The profiled follow-up passes **219 tests** (121 database-independent, 98 integration). It removes
the redundant decoded-value array, numeric Buffer views and unnecessary promise suspension for ordinary
packets. Pool cleanup allocates expiry signals/errors only when observed, unconstrained lifetimes
avoid abort composition, and empty drains need no cleanup timer. New/expanded checks retain inherited
deadline/cancellation behavior and safe writable/enumerable own properties for special column names.
See [profiling](../benchmarks/README.md#profiling) for evidence and reproduction.
The final runtime checkpoint `990ac77` was committed before its measurements. Its full check passes
219 tests, native compatibility passes three tests, and the packed Tenon trial passes the 180-test
pg baseline and 20 candidate cases with a clean working tree
(`.trial-dist/tenon-m4-kVzHLC/report.json`). The 126-measurement matrix also passes. Five alternating
longer runs per artifact show about 22% higher large-result throughput and 93% higher pool
throughput, with lower CPU use; see [results](../benchmarks/README.md#profiled-follow-up-results).
These are local PostgreSQL 16.15 results, not a new PostgreSQL 18 CI claim.

The M1–M5 lifecycle cleanup on 2026-10-28 passed `npm run check`: **203 tests**
(109 database-independent, 94 integration) against the existing `pgclear_test` database. The new
regressions verify that synchronous user code blocking timer callbacks cannot cause overdue queued
work to dispatch or an overdue acquisition to publish a lease. All 201 prior tests remain.

Internal lifetimes now share absolute deadlines across acquisition, scopes and wire work. Lease
wrappers, scope finalization, child admission and recovery are shared while preserving discard,
rollback and COMMIT policies. Startup state, codec types, close validation and API re-exports are
simpler. Lifecycle subprocesses use a typechecked fixture against the built package and shared
fake-session setup; long-timer, abort-listener and natural-exit assertions are retained. The source
also passes an explicit unused-local/parameter TypeScript check. [D31](decisions.md#d31--share-lifecycle-ownership-and-enforce-deadlines-at-admission-boundaries)
records the resulting ownership rules.

The earlier M5 simplification on 2026-10-28 passed `npm run check`: **201 tests**
(107 database-independent, 94 integration) against the existing `pgclear_test` database. Explicit
preparation, portal row streaming and COPY FROM/TO are implemented on their owning held-session,
transaction and savepoint scopes. Native values, strict binds, immutable codecs, FIFO reservation,
expiration and no automatic execution retries remain intact.

New COPY coverage includes fragmented text and binary round trips, Node Readables, source/iterator
failures, server failures, wrong SQL/direction, opaque chunk ownership, bounded source/socket
backpressure, result limits, queued/active cancellation, paused consumers, deadlines, partial close,
stalled producer cleanup, forced shutdown and verified TLS. Six subprocess scenarios verify long
operation timers, external abort listeners, producer cleanup and sockets do not strand a process.
Packed consumers exercise COPY runtime exports and strict byte-source/output/completion types.

The simplification replaces named stream/COPY portals and their extra cleanup cycles with unnamed
portals, a discriminated operation state and one bounded row/byte handoff. COPY input uses an ordinary
async source task, and scope ownership uses one reservation. A single absolute cleanup budget carries
through statement disposal, rollback and release. Bind encoding, public option validation and
fake-server helpers are shared. `queryClassic` remains a public entrypoint with packed-consumer and
scope-ownership coverage. [D30](decisions.md#d30--exclusive-execution-needs-no-named-portal-resource-layer)
records the change; D27–D29 retain the original M5 decisions.

All 199 prior tests remain, with two new integration workflows: manual transaction/savepoint recovery
across stream/COPY completion, source failure and partial close; and source getter/iterator reentrancy
blocked by the scope reservation. The seeded 25-step mixed lifetime workflow now checks all remaining
cursors before reuse. Native command evidence, decoder errors, stalled cleanup, cancellation,
backpressure, TLS and child-process exit checks remain green.

This is local evidence. No PostgreSQL 18/CI result for M5, publication, production performance or
full Tenon migration is claimed. Local PostgreSQL was preserved; the existing isolated CI matrix
remains the PostgreSQL 16/18 compatibility gate. No new CI run was awaited.

M5b on 2026-10-28 passed `npm run check`: **161 tests** (85 database-independent, 76 integration)
against the existing `pgclear_test` database. Portal streams now work on held sessions and
transaction/savepoint scopes. Tests cover exact and partial batch boundaries, eager first batches
and demand-driven continuation, metadata, object/array decoding, strict parameters, isolated codecs,
encoder reentrancy/deadlines, exclusive/single-consumer ownership, early exit, queued/active close,
callback abandonment/rollback, paused-consumer cancellation/deadlines, per-batch byte bounds, losses
throughout the protocol, malformed/excess responses and failed portal disposal. Packed consumers
verify exported streaming types, inferred tagged rows, unknown unannotated values and closed
completion narrowing. Child-process fixtures verify timers/listeners are removed on success, early
close, server error, timeout and abort. Prior M5a regressions remain green.

PostgreSQL returns the final Execute's fetched row count for a row-returning portal; exact batch
boundaries can end with a zero count. Tests retain that native command tag/count. Early write-stream
close is also verified to permit server-side effects while exposing only `status: 'closed'`.
[D28](decisions.md#d28--streaming-owns-one-scope-and-retains-native-completion-evidence) records these
semantics. COPY remains M5c; no new PostgreSQL 18/CI, publication or full Tenon migration evidence is
claimed.

M5a on 2026-10-28 passed `npm run check`: **132 tests** (70 database-independent, 62 integration)
against the existing `pgclear_test` database. Named preparation is available on exact session,
transaction and savepoint scopes ([D27](decisions.md#d27--prepared-statements-belong-to-their-creating-scope)).
Coverage includes metadata/readiness, creation loss at each protocol boundary, valid/invalid/valid
reuse, reentrant query/Close FIFO, owner expiry, failed transaction/savepoint cleanup, immutable codec
isolation, array rows, decoder/server errors, invalidation without retries, queued/active cancellation,
encoder deadlines, failed Close retirement and packed-consumer types/exports. Child-process fixtures
verify preparation/Close remove timers and abort listeners. Streaming and COPY remain M5b/M5c. No
new PostgreSQL 18, CI, publication or full Tenon migration result is claimed.

Readiness update (2026-10-28): both PostgreSQL 16/18 jobs passed the full driver check for the
Unicode-fix commit `e742fbf` in
[run 40642777907](https://github.com/kequtech/pgclear/actions/runs/40642777907). This verifies that
commit, not the later tag/classic API checkpoint. D26 resumes focused M5a development while full
Tenon adoption and the newer checkpoint's PostgreSQL 18 result remain unverified. See
[the handoff](m5-handoff.md).

The D25 driver API pass on 2026-10-28 passed `npm run check`: **106 tests**
(56 database-independent, 50 integration) against PostgreSQL 16.15. Tagged and classic queries,
readonly tuples and existing statement objects use the same encoding/ownership path. Added cases
cover bound Unicode/injection-like text, explicit JSON/arrays, malformed tuples, invalid binds,
array row mode, pool/session/transaction/savepoint use, and expired handles. Packed consumers verify
row inference from `sql<Row>`, `queryClassic<Row>` and `Pick`, including that unannotated tags stay
unknown rather than taking an expected type from the surrounding assignment. Generation and query
checking remain Tenon responsibilities. No new PostgreSQL 18 or CI result is claimed.

The post-M4 Unicode correctness pass on 2026-10-28 passed `npm run check`: **100 tests**
(53 database-independent, 47 integration) on PostgreSQL 16.15. The Tenon review's leading-U+FEFF and
Unicode-array-space reproductions failed before the fixes and pass afterward. Coverage includes
field names, Describe/script metadata, diagnostics, custom codecs, 20 non-ASCII characters at array
edges, ASCII grammar/escapes, nested/bounded arrays and comparison with server JSON output. These
regressions subsequently passed the existing PostgreSQL 16/18 CI matrix for `e742fbf`, as recorded
above. Docker Desktop is not integrated with this WSL distribution, so no
isolated local PostgreSQL 18 run was performed and the local PostgreSQL 16 environment was unchanged.

On 2026-10-28, M3 passed `npm run check`: 93 tests (49 database-independent, 44 integration) against
local PostgreSQL 16.15. Added coverage includes lazy/capacity-accounted pooling, FIFO and canceled
acquisitions, cold concurrent startup, expired leases/callbacks, release during activity, idle/lifetime
retirement, scoped transactions/savepoints, manual SQL-error recovery, poisoned savepoint recovery,
accepted unawaited work, backend loss during/between transaction statements and whole-callback
deadlines. A seeded checkout/release/cancel sequence retains its seed for failures.

Fake servers distinguish lost COMMIT, an explicit ROLLBACK tag and a COMMIT tag followed by lost
ReadyForQuery. Shutdown tests cover TCP/TLS/auth/startup, late credentials, cancellation transport
faults, forced disposal and all-resource cleanup after a disposer rejects. Cancellation verifies TLS
and backend-key packets on a separate transport. Packed consumers import the actual M3 API and exit
after close. Child processes exit after successful/failed session and transaction callbacks with
one-hour deadlines, and their external abort listeners are removed. PostgreSQL cancellation responses are now observed; timeout alone still cannot establish
rollback. Existing M1/M2 regression coverage remains in the same suite.

M2 was pushed as `e37c28b`; its CI result was deliberately not awaited before M3 at the maintainer's
request. M3 was pushed as `a91a83b`; its CI was likewise not polled or awaited. No new
PostgreSQL 16/18 CI success is claimed.

On 2026-10-28, M2 passed `npm run check`: 63 tests (38 database-independent, 25 integration) against
local PostgreSQL 16.15 and Node 24.4.1. M2 coverage includes exact scalar/numeric-array/bigint values,
array grammar/nesting/bounds/box delimiters, immutable registry overrides, SQL NULL versus JSON null,
raw JSON precision, binary typed parameters, valid/invalid/valid encoding, reentrant/expired encoders,
decoder recovery, Describe without execution and script transaction semantics. Child processes exit
after Describe success/server-error/abort/timeout; abort listeners are removed. Buffered limits cover
rows, metadata and zero-row scripts. The external packed JavaScript/TypeScript consumer uses actual
exports/declarations and exits after close.

M1 coverage remains: field origins, affected counts, raw transaction status, backend termination,
65,535 parameters, bounded queues/close, Unicode-auth roles compared with libpq,
fragmentation/coalescing, malformed frames/strings, RFC 7677 proof vectors, invalid proofs/nonces,
MD5 compatibility, verified TLS including wrong CA/hostname, SHA384 channel binding, Unix-socket
passwords, deadline disposal and late credential results.

The CI evidence below applies to M1; it does not establish M2/M3 CI results.

The [M1 CI run](https://github.com/kequtech/pgclear/actions/runs/40629729303) passed the full
`npm run check` separately on PostgreSQL 16 and 18 for implementation commit `7529693` on 2026-10-28.
Both matrix jobs completed successfully, including their dependency installation and test steps.
PostgreSQL 18 ran only in an isolated GitHub Actions service container; the local installation
remains PostgreSQL 16. No local upgrade is needed for this compatibility gate.

The fake TLS server establishes transport/channel-binding behavior; this is not a claim of a full
real-server TLS/proxy deployment matrix. SCRAM iteration counts above 100,000 and unsupported
certificate signature digests fail explicitly. Default temporal/numeric/unknown types remain text;
built-in arrays use the selected scalar decoders. JSON.parse still has JavaScript numeric precision
limits; raw JSON codecs are the explicit alternative. Binary results and catalog-driven custom array
discovery are not implemented. Active interruption uses protocol cancellation and retires the session, bounded by cleanup time;
force-close disposes both transports. Managed scopes classify lost COMMIT responses separately.
Full Tenon adoption remains open. M6 later adds real TLS/Unix/proxy evidence, recorded above.

## Deployment compatibility

`test/compatibility/pgbouncer.json` pins official PgBouncer **1.26.1** source and its SHA256.
The [source releases](https://www.pgbouncer.org/downloads/) supply the archive and checksum.
Build it with C build tools, pkg-config, libevent/OpenSSL development headers, and `tar`:

```sh
node scripts/build-pgbouncer.mjs /tmp/pgclear-pgbouncer
PGCLEAR_PGBOUNCER=/tmp/pgclear-pgbouncer/pgbouncer-1.26.1/pgbouncer npm run test:compat
```

The build directory must not exist. Source/configuration/build logs stay there. The test fixture
uses native `initdb`/`pg_ctl` from `pg_config --bindir`; set `PGCLEAR_POSTGRES_BIN` to select another
installed version. Run as an ordinary user. It creates and removes an owned temporary PostgreSQL
cluster with database `pgclear_test`, public test credentials `postgres:postgres`, loopback ports,
Unix sockets and the existing test-only certificate. It never edits, upgrades or stops the configured
PostgreSQL server/database. PgBouncer runs in the foreground and all owned processes are stopped
before the temporary directory is removed, including after failures.

The exact proxy configuration lives in `test/compatibility/server.ts`. It uses SCRAM client/backend
authentication, required client TLS, verify-full backend TLS, two backend connections per pool and
`max_prepared_statements=0`. Separate aliases select session and transaction pooling. Session tests
cover explicit preparation, COPY, cursor batches and LISTEN/NOTIFY. Transaction tests cover unnamed
binds, concurrent pinned transactions, temporary ON COMMIT DROP tables, savepoint recovery and active
cancellation/retirement. They make no LISTEN or session-persistence claim for transaction pooling,
consistent with [PgBouncer's feature map](https://www.pgbouncer.org/features.html).

Native tests require verified TLS and SCRAM-PLUS on TCP, and use SCRAM over plaintext Unix sockets.
Native PostgreSQL refused TLS negotiation on its Unix socket; these are separate tested profiles.
The local result used PostgreSQL **16.15**. GitHub Actions configures independent native PostgreSQL
16/18 jobs on Ubuntu 24.04 using the official PostgreSQL package repository and the same pinned
proxy build. Their execution remains unverified until this checkpoint runs in CI.

## Tenon adapter trial

`npm run trial:tenon` runs the optional, pinned consumer trial from a sibling Tenon checkout. Pass
`-- --source /path/to/tenon-orm` for another checkout containing the pinned commit. It uses the same
ignored `.env` and requires the existing `pgclear_test` database explicitly. It never loads Tenon's
`.env`, fetches a moving branch, edits the source checkout or publishes a package.

The runner packs pgclear, archives Tenon 0.3.1 twice, runs the full pg baseline, applies the reviewed
adapter patch only to the candidate snapshot, builds strict declarations, and installs both tarballs
into separate external consumers. The shared contract fixture checks runtime values, ORM policies,
inspection/generation, migration scripts, session loss and ownership. Generated types compile under
TypeScript 6 and 7. Dependencies are installed with lifecycle scripts disabled; build/test commands
are then run explicitly.

Output stays under ignored `.trial-dist/tenon-m4-*`: artifact SHA256 hashes, per-step logs and
`report.json`. `.trial-dist/latest-tenon-trial.json` points to the most recent attempt. This optional
trial is separate from `npm run check`, which needs neither another repository nor its dependencies.
See [trial evidence](tenon-trial.md) for exact scope and limits. No registry version is required.

## Test database

The user supplied the existing local **pgclear_test** database and the existing `postgres` role.
Connection was verified on 2026-10-28: database `pgclear_test`, role `postgres`, PostgreSQL 16.15.
No database, role or test data was created, reset or dropped during onboarding.

Use `PGCLEAR_TEST_DATABASE_URL` in the ignored `.env`; `.env.example` contains placeholders. Local
credentials follow the existing PostgreSQL convention. Never commit `.env`. Test scripts load
that file explicitly with Node's `--env-file-if-exists=.env`; the driver does not load it. CI supplies
the same named variable directly and uses an isolated `pgclear_test` service database.

Only test persistence is needed for this library, so onboarding does not create a redundant app or
development database. If later examples need separate persistent development data, configure a
distinct database before using it. The integration harness refuses non-test databases and verifies
current_database before mutating anything. Schema tests use random owned names. Authentication
comparison creates random, temporary LOGIN roles and removes them afterward, using the supplied
postgres role's test administration privileges; no per-project role/password is retained. Backend
termination/cancellation additionally matches both a known PID and random application name. No test
drops or resets the supplied database.

## GitHub checks and documentation

The `Check` workflow runs `npm ci` and `npm run check` on pushes to main and pull requests, using
PostgreSQL 16/18 service containers with SCRAM host authentication. M3 pool/transaction tests run in this same matrix without another workflow.

The documentation workflow uses the canonical shared Kequtech action on docs changes pushed to main.
It reads `SITE_EDITORIAL_INGEST_TOKEN` from GitHub Actions secrets and `kequtech.source` from the
manifest. The ingest credential belongs in process configuration and Actions secrets, never this
repository or workflow text. Setup verifies secret metadata; successful ingestion must be observed
from a real workflow run and is not implied by the file or secret merely existing.

The repository Actions secret was configured from the existing process credential during onboarding;
its name was verified without reading its value back. Organization-secret metadata was unavailable
with the current GitHub permissions; no organization policy was changed.

GitHub organization-secret metadata may require permissions beyond repository access. Preserve any
existing repository credential, check organization applicability where permitted, and do not widen
organization secret access as a side effect of setup.

## Working on the implementation

Read [the API](public-api.md), [architecture](architecture.md), and the next incomplete milestone in
[the plan](implementation-plan.md). Changes to accepted public behavior update the contract and
decision log together. Keep the project single-package and avoid scaffolding unsupported runtimes,
application authentication, deployments, or an ORM. Add tests for observable protocol/workflow
behavior when the corresponding implementation is introduced, not tests that inspect docs wording.
