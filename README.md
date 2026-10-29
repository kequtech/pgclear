# pgclear

A standalone TypeScript PostgreSQL driver with explicit session ownership and no runtime
dependencies. For Node.js 24+, using ESM. PostgreSQL 16 and 18 are tested.

**0.1.0 is prepared for its first release; publication is pending.**

```ts
import { connect } from '@kequtech/pgclear';

const connection = await connect({ connectionString: process.env.DATABASE_URL! });
try {
  const result = await connection.queryClassic<{ value: number }>(
    'SELECT $1::integer AS value',
    [42],
  );
  console.log(result.rows[0]?.value);
  // result: { rows, fields, command, commandTag, rowCount }
  // rowCount is bigint | null. Row annotations are assertions, not runtime checks.
} finally {
  await connection.close();
}
```

`queryClassic` is a supported library entry point for finished SQL and bind values. `query` uses the
same execution and conversion path and also accepts a `[text, values]` tuple, a
`{ text, values, parameterTypes }` statement, or a value-binding tag:

```ts
import { sql } from '@kequtech/pgclear';

const query = sql<{ value: number }>`SELECT ${42}::integer AS value`;
// ['SELECT $1::integer AS value', [42]]
```

SQL composition and checking belong to callers.
Tenon is the primary consumer, and other libraries can use the same public API.

Connections, bounded pools, transactions/savepoints, Describe, scripts, explicit prepared
statements, row streams, byte COPY and dedicated notification listeners are implemented.
Operations execute sequentially per physical connection. There is no automatic query retry,
prepared-statement cache or pipelining. Timeouts and connection loss do not prove a write rolled back.

Default values preserve large integers as `bigint`, exact decimals and temporal values as strings,
and bytes as `Uint8Array`. JSON uses `JSON.parse`; applications needing exact JSON numeric tokens can
select the raw JSON text codecs. Supported built-in arrays decode recursively; unfamiliar types
stay text. Plain objects, arrays and `Date` are not implicit binds: use `json`, `param` or authored
wire text. See [the public API](docs/public-api.md#codecs-and-parameters) for the full mapping and examples.

`generateDefinitions({ connection: pool, namespace: 'public' })` returns TypeScript source from a
consistent read-only database snapshot. It exports `Database['users']['row']`,
`Database['users']['insert']` and `Database['users']['update']`, with relationships and indexes in
comments. The caller owns file output and checking; supplied pools/sessions retain their ownership.
`codecs.typescript(oid)` exposes the selected decoder's known representation for query tooling;
unrecognized custom decoders return `undefined` and need application declarations.

[Public API](docs/public-api.md) covers configuration, ownership, results, errors, codecs, streaming,
COPY, listeners and generation. [Release notes](CHANGELOG.md) describe the 0.1.0 boundary.
Contributor documentation, design history, validation evidence and benchmarks remain in the
[repository](https://github.com/kequtech/pgclear).

From a checkout, `npm ci` followed by `npm run check` checks formatting, types, packed consumers and
real PostgreSQL workflows. Integration tests require `PGCLEAR_TEST_DATABASE_URL` naming an explicit
`_test` database and `psql`. `npm run test:unit` needs no database; `npm run test:compat` separately
exercises native TLS/Unix/PgBouncer fixtures. See the repository's `docs/development.md` for setup.
