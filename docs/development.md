# Development

Use Node.js 24+, npm, `psql` and `tar`. Fake-server tests need permission to open loopback and Unix
sockets. Integration tests need a separate PostgreSQL database whose name ends in `_test`.

```sh
npm ci
# If needed, copy .env.example to .env and set your existing test database URL.
npm run check
```

Local development uses the existing `postgres` role and `pgclear_test` database. Tests create and
remove their own schemas, roles and connections; use a test administrator with those permissions.
Do not point tests at application data. Test scripts load `.env`; the driver itself does not.

| Command                    | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `npm run check`            | Formatting, types, unit/packed-consumer tests and integration tests |
| `npm run test:unit`        | Unit, fake-server and packed-consumer tests; no database            |
| `npm run test:integration` | Real PostgreSQL workflows using PGCLEAR_TEST_DATABASE_URL           |
| `npm run typecheck`        | Strict types, including compile-only usage examples                 |
| `npm run format`           | Apply Prettier                                                      |
| `npm run build`            | JavaScript, declarations and self-contained JS maps in dist/        |
| `npm pack`                 | Build and create a local package archive; does not publish          |
| `npm run test:compat`      | Disposable native TLS/Unix/PgBouncer fixtures                       |
| `npm run trial:tenon`      | Optional pinned consumer regression trial                           |
| `npm run benchmark`        | Optional benchmark matrix                                           |

## Compatibility tests

Install native PostgreSQL tools (`initdb`, `pg_ctl`, `pg_config`), C build tools, pkg-config,
libevent/OpenSSL development headers and tar. Build the checksum-pinned PgBouncer into a new directory:

```sh
node scripts/build-pgbouncer.mjs /tmp/pgclear-pgbouncer
PGCLEAR_PGBOUNCER=/tmp/pgclear-pgbouncer/pgbouncer-1.26.1/pgbouncer npm run test:compat
```

`PGCLEAR_POSTGRES_BIN` selects another installed PostgreSQL binary directory; otherwise the fixture
uses `pg_config --bindir`. Run as an ordinary user. The fixture owns and removes its temporary cluster,
loopback ports, Unix sockets and proxy processes; it does not reconfigure the existing server.
Test-only certificates are documented in [test/fixtures](../test/fixtures/README.md).

The fixture covers native verified TLS/SCRAM-PLUS, SCRAM on Unix sockets, and PgBouncer 1.26.1
session/transaction pooling. Proxy settings are in `test/compatibility/server.ts`: verified backend
TLS, two backend connections per pool and `max_prepared_statements=0`. Session tests cover preparation,
COPY, streams and notifications. Transaction tests cover unnamed queries, pinned transactions,
savepoint recovery and cancellation; they do not promise session persistence or LISTEN.

## Consumer trial and benchmarks

See [the Tenon trial](tenon-trial.md) for the pinned source, adapted regressions and reproduction.
It runs from isolated snapshots without editing Tenon's checkout. It is optional and separate from
`npm run check`. See [benchmarks](../benchmarks/README.md) for performance commands and measurements.

## Package and release

The package is ESM-only and has no runtime dependencies. The tarball includes README, release notes,
LICENSE, the API guide/index, JavaScript, declarations and JS maps with embedded sources. Contributor
documents, tests, benchmark dependencies and trial artifacts stay in the repository.

Before publishing a release, run checks on the chosen revision, inspect/install the packed archive,
and verify documentation links. License attribution for PostgreSQL's password-preparation tables is
included in LICENSE.

To regenerate those tables, run `node scripts/generate-saslprep.mjs /path/to/saslprep.c`. The generator
verifies a pinned source checksum and does not run during installation or application execution.

## Recorded validation

The [0.1.0 checkpoint](release-0.1.0-validation.json) records candidate revision, artifact hash and
local PostgreSQL 16.15/18.0 results: 232 driver tests, three compatibility workflows, 180 adapted
Tenon tests and 20 packed candidate contracts on each version, with no candidate skips. The original
pg baseline passes separately. These are checkpoint results, not a claim that subsequent commits
ran CI. GitHub Actions is configured for Node 24 and PostgreSQL 16/18.

The [earlier implementation checkpoint](validation-2026-10-29.json) and benchmark result files retain
historical provenance. Raw reports, generated packages and logs stay in ignored `.trial-dist` and
`.benchmark-dist` directories. Keep credentials and `.env` files out of Git.

## Changing the implementation

Keep public behavior in [the API guide](public-api.md) consistent with `src/index.ts` and its types.
Compile-only examples live in `test/fixtures/api-examples.ts`; observable workflows belong in tests.
[Architecture](architecture.md) describes the ownership boundaries. Use the existing package and
Node test runner; add abstractions or dependencies only for a demonstrated need.
