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
distribution locally and does not publish it. The only runtime exports are connect/DriverError/DatabaseError.

## Current verification and limits

On 2026-10-28, `npm run check` passed 42 tests (28 database-independent and 14 integration) against
local PostgreSQL 16.15 and Node 24.4.1. They cover scalar
parameter/NULL round trips, field origins, affected counts, error recovery, raw transaction status,
backend termination, all 65,535 protocol parameters, result limits including empty/NULL row framing,
bounded queue/close behavior, and temporary Unicode-auth roles compared with
libpq. Protocol/authentication tests include fragmentation/coalescing, malformed frames and strings,
RFC 7677 proof vectors, invalid proofs/nonces, MD5 compatibility, verified TLS (including wrong
CA/hostname), SHA384 certificate channel binding, Unix-socket passwords, deadline disposal and late
credential results. A packed consumer imports actual exports, checks declarations, connects and
exits after close without a retained client timer/socket.

PostgreSQL 18 is configured in CI but has not been run locally; the available local cluster is 16.
The fake TLS server establishes transport/channel-binding behavior; this is not a claim of a full
real-server TLS/proxy deployment matrix. SCRAM iteration counts above 100,000 and unsupported
certificate signature digests fail explicitly. Default temporal/numeric/unknown types remain text;
M2 implements the custom codec registry and built-in arrays. Active interruption currently destroys
the transport rather than sending CancelRequest, and does not establish server rollback. M3 adds
protocol cancellation and managed transaction handling, including COMMIT_UNKNOWN classification.

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
PostgreSQL 16/18 service containers with SCRAM host authentication. M3 extends this matrix's coverage.

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
