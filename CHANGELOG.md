# Release notes

## 0.1.0

Initial release, prepared but not yet published.

- ESM PostgreSQL driver for Node.js 24+, with no runtime dependencies. Tested on PostgreSQL 16/18.
- Ordinary and classic parameterized queries, field/command metadata, Describe and scripts.
- Explicit connection, pool, lease, transaction and savepoint ownership; bounded cancellation,
  cleanup and shutdown, with write-outcome diagnostics.
- Immutable codecs, explicit JSON/typed parameters, recursive built-in arrays, exact bigint/decimal
  defaults and temporal wire text. JSON parsing follows JavaScript number semantics.
- Scope-owned prepared statements, bounded portal row streams, byte COPY and dedicated notification
  listeners with opt-in reconnect.
- Schema type generation as a library export, including row/insert/update types and relationship/index
  comments. SQL composition, checking, migrations and generated-file ownership stay with consumers.

Queries execute sequentially per physical connection. Pipelining, binary result negotiation,
automatic type discovery, browser runtimes and pg-compatible implicit binds are outside this release.
