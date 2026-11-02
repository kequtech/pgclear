# Development and testing

[Overview](README.md) · [Architecture](ARCHITECTURE.md) · [Benchmarks](benchmarks/README.md)

Use Node.js 24+, npm, `psql`, and `tar`. Start with the existing package and lockfile:

```sh
npm ci
npm run test:unit
```

Unit tests include scripted PostgreSQL servers and packed-package consumers. They need permission
to open loopback and Unix sockets, but do not need a running database.

## Integration tests

Use a separate database with a name ending in `_test`. The local convention is the existing
`postgres:postgres` role and `pgclear_test` database; reuse an already configured test connection.
Copy `.env.example` to the ignored `.env` only if you need local configuration:

```sh
cp .env.example .env
# Edit PGCLEAR_TEST_DATABASE_URL to point at your test database.
npm run check
```

`PGCLEAR_TEST_DATABASE_URL` must name the database in the URI path, without a `dbname` query
parameter. Tests create/remove schemas, roles, and connections, so use a test administrator with
those permissions. Do not point them at application data. Integration scripts load `.env`; the
driver itself does not. Integration tests fail when their database URL is missing.

## Commands

| Command                                   | Purpose                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run check`                           | Formatting, strict types, unit/packed-consumer tests, and integration tests      |
| `npm run test:unit`                       | Build and run unit, fake-server, package, lifecycle, and benchmark-harness tests |
| `npm run test:integration`                | Compile and run real PostgreSQL workflows                                        |
| `npm run typecheck`                       | Strict types, including compile-only public API examples                         |
| `npm run format` / `npm run format:check` | Apply / check Prettier                                                           |
| `npm run build`                           | Emit JavaScript, declarations, and self-contained JS maps to `dist/`             |
| `npm pack`                                | Build and create a local package archive; does not publish                       |
| `npm run test:compat`                     | Disposable native TLS, Unix socket, and PgBouncer tests                          |
| `npm run benchmark`                       | Optional benchmark matrix; separate comparator installation required             |

`npm test` runs unit tests followed by integration tests. `test:integration` compiles source tests;
run `npm run build` first when invoking it alone after implementation changes, since some packed
consumer workflows use `dist/`.

## Compatibility tests

Install native PostgreSQL tools (`initdb`, `pg_ctl`, `pg_config`), C build tools, pkg-config,
libevent/OpenSSL development headers, and tar. Build the checksum-pinned PgBouncer into a new directory:

```sh
node scripts/build-pgbouncer.mjs /tmp/pgclear-pgbouncer
PGCLEAR_PGBOUNCER=/tmp/pgclear-pgbouncer/pgbouncer-1.26.1/pgbouncer npm run test:compat
```

`PGCLEAR_POSTGRES_BIN` selects an installed PostgreSQL binary directory; otherwise the fixture uses
`pg_config --bindir`. Run as an ordinary user. The fixture creates and removes its own temporary
cluster, loopback ports, Unix sockets, and proxy processes. It does not reconfigure your existing
server. [Test fixture documentation](test/fixtures/README.md) describes the public test certificates.

The fixture covers verified TLS/SCRAM-PLUS, SCRAM on Unix sockets, and PgBouncer 1.26.1 session and
transaction pooling. Proxy settings are in `test/compatibility/server.ts`: verified backend TLS,
two backend connections per pool, and `max_prepared_statements=0`. Session tests cover preparation,
COPY, streams, and notifications. Transaction tests cover unnamed queries, pinned transactions,
savepoint recovery, and cancellation. They do not promise session persistence or LISTEN.

## Making changes

Keep the [API reference](docs/reference.md) and linked guides aligned with `src/index.ts` and `src/types.ts`.
Put executable behavior checks in workflow/function tests. The consumer ownership example lives
in `examples/shared-listener.ts`; keep it typechecked and test its public lifecycle behavior.
The development TypeScript path mapping checks package imports against `src/index.ts` before a
build exists; emitted example imports still use the installed package. Compile-only usage and
rejected-call examples live in `test/fixtures/api-examples.ts`. The test compiler inherits the root
source/test/example file list; the library build includes only `src/`. Prefer observable barriers over timing guesses in
lifecycle tests. Keep source changes separate from unrelated generated or trial artifacts.

[Architecture](ARCHITECTURE.md) explains module responsibilities and ownership. Use the existing
TypeScript, npm, and Node test runner; add abstractions or dependencies only for demonstrated needs.
The [benchmark guide](benchmarks/README.md) covers reproduction, workloads, and measurement limits.
Benchmark timing is opt-in and is not a CI performance gate.

## Package and release

The package is ESM-only and has no runtime dependencies. It ships JavaScript, declarations, maps
with embedded sources, LICENSE, README, release notes, all consumer guides, and the shared-listener
example source. Contributor guides, tests, benchmark dependencies, and trial artifacts stay in the
repository.

For a release:

1. Update `package.json`, the root package/version entries in `package-lock.json`, and `CHANGELOG.md`.
2. Run `npm run check`; run native compatibility checks when affected.
3. Use `npm pack --dry-run` to inspect the file list and version. Packed-consumer tests also install
   an archive and check real exports, types, maps, and resource cleanup.
4. Check relative documentation links in the repository and the packed guide set.
5. Publish the verified revision through the existing release process when authorized.

Documentation-only releases use a new patch version. Follow the [compatibility policy](docs/reference.md#compatibility)
for API or representation changes. Publishing is separate from preparing a package.

CI is configured for Node 24/26 and PostgreSQL 16/18. Native Temporal tests skip when Temporal is
unavailable; real polyfill tests cover both runtimes. The polyfill is a development dependency and
is never imported by the driver.

PostgreSQL password-preparation table attribution is in LICENSE. To regenerate the tables, run
`node scripts/generate-saslprep.mjs /path/to/saslprep.c`. The offline generator verifies a pinned
source checksum and does not run during installation or application execution.

## Validation records

Keep command results and artifact hashes with the release under review. Old candidate matrices and
scratch paths are not current validation evidence; Git history retains earlier investigations.
Benchmark data remains in benchmarks/results because it supports measured comparisons.
