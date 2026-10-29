# Release notes

## 0.3.1

- Reject incompatible SQL tags in `pool.query()` before acquiring or opening a connection, so
  local tag errors report `PGCLEAR_ENCODE` even when the database is unavailable.

## 0.3.0

- Breaking: remove `generateDefinitions`, `GenerateOptions` and the schema generator. Move schema
  generation to Tenon; published pgclear 0.2.0 remains unchanged.
- Expose the immutable selected registry as `Executor.codecs` and add per-operation result `codecs`
  to ordinary, prepared and streamed queries. Overrides preserve session ownership, executor defaults
  and parameter encoders.
- Accept Date, bigint and supported native/polyfilled Temporal values as ordinary parameters.
  Date values encode in UTC; JSON and PostgreSQL arrays keep explicit encoders.
- Allow custom text codecs to declare output TypeScript representations, including derived arrays,
  and expose known expressions for downstream checking and generation.
- `CodecRegistry.typescriptTypes()` is a required public capability; consumers implementing or
  mocking the interface must supply it. Integrations using these APIs must require pgclear 0.3.0+.
- Add opt-in int8 bigint, timestamptz Date and supplied-Temporal codecs; string output defaults remain.
- Check Node 24 and Node 26 so native Temporal and environments without Temporal are both covered.

- Select result and array-element decoders once per column and fill rows directly, reducing
  per-value lookups and temporary allocations while preserving decoding validation and row behavior.

## 0.2.0

- Breaking: `query` accepts only `sql` tag results. Use `queryClassic(text, values, options)` for
  finished SQL; text, manual tuples and statement objects are no longer accepted by `query`.
- `queryClassic(text)` defaults to an empty values array; array-row options can use an undefined
  values argument.
- Accidental async parameter encoders reject before dispatch and have their promise rejections
  observed, matching decoder handling.
- Breaking: int8/bigserial values and int8 array elements use exact strings instead of bigint.
  Plain bigint binds are no longer accepted; use strings or `param(text, builtin.int8)`.
- Breaking: query, prepared-statement, script, COPY and stream command counts use `number | null`.
  Counts beyond JavaScript's safe integer range reject instead of rounding.
- Completed row streams report total returned rows across all batches while preserving raw command
  tags. Early close continues to report no final count.
- Document custom codec representations, exact integers/counts and the compatibility policy.

## 0.1.0

Initial release.

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
