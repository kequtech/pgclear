# Development and setup

## Current project state

The repository is `git@github.com:kequtech/pgclear.git`, private, with `main` as the default
branch. The package is `@kequtech/pgclear`, unpublished and protected by `private: true`. The stable
Kequtech source identity is `pgclear`. Node.js 24+, npm, TypeScript and Prettier are the tooling
foundations. `@mongodb-js/saslprep` is the one direct runtime dependency, for PostgreSQL-compatible
SCRAM password normalization. Native Node modules handle networking, TLS and cryptography.

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

Fake-server tests require loopback/Unix sockets. Integration tests require `psql`; packed-consumer
tests use `tar` and reuse only runtime dependencies declared in the packed manifest. TLS fixtures
are explicitly public test-only keys/certificates. The package remains private; `npm pack` exercises
distribution locally and does not publish it. The runtime exports are `connect`, `createPool`, `DriverError`, `DatabaseError`, `builtin`, `defaultCodecs`, `param`
and `json`.

## Current verification and limits

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
regressions run automatically in the existing PostgreSQL 16/18 CI matrix on the next push; that CI
result has not yet been observed. Docker Desktop is not integrated with this WSL distribution, so no
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
Tenon adaptation, prepared statements, streaming, COPY, listeners and a real proxy/TLS deployment
matrix remain unverified later work.

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
