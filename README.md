# pgclear

A PostgreSQL driver for JavaScript and TypeScript on Node.js 24+. ESM only, with TypeScript
declarations and no runtime dependencies. Tested with PostgreSQL 16 and 18.

pgclear sends your SQL to PostgreSQL, binds values separately, and decodes the results. It provides
connection pools, transactions, prepared statements, row streams, COPY, and notifications. Each
connection runs one operation at a time; a pool lets independent operations use separate connections.

## Install and run a query

```sh
npm install @kequtech/pgclear
```

Set `DATABASE_URL` to your PostgreSQL connection URI. Save this as `example.mjs` and run it with
`node example.mjs`:

```js
import { createPool, sql } from '@kequtech/pgclear';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL before running this example.');

const pool = createPool(connectionString);
try {
  const message = 'Hello, PostgreSQL!';
  const result = await pool.query(sql`SELECT ${message} AS message`);
  console.log(result.rows[0]?.message); // Hello, PostgreSQL!
} finally {
  await pool.close();
}
```

The `sql` tag turns `${message}` into a `$1` placeholder and a separate bound value. It does not
insert the value into the SQL text. For existing SQL with numbered placeholders, use
`queryClassic(text, values)`:

```ts
const result = await pool.queryClassic<{ message: string }>('SELECT $1 AS message', [
  'Hello, PostgreSQL!',
]);
```

Both methods return `rows`, `fields`, `command`, `commandTag`, and `rowCount`. TypeScript row
annotations describe what you expect; pgclear does not validate them against your SQL.

The pool opens connections on demand. In an application, create one pool, reuse it, and close it
at shutdown. The application must read environment variables and pass them to pgclear; the driver
does not load `DATABASE_URL` or `.env` automatically.

## Keep related work on one connection

Separate pool queries can use different connections. A transaction callback holds one connection,
commits when the callback succeeds, and rolls back when it throws:

```ts
await pool.transaction(async (tx) => {
  await tx.queryClassic('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [10, 1]);
  await tx.queryClassic('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [10, 2]);
});
```

This example assumes an `accounts` table. Use the supplied `tx` handle for all work in the
transaction. Use `pool.withSession` when you need one connection without starting a transaction.
Prepared statements, streams, and COPY also run through a held session.

## Know your values

- `int8`/`bigserial` and `numeric`/`decimal` results are strings to preserve precision. That includes
  `count(*)`. Command metadata such as `rowCount` is a `number | null`.
- Dates and times are strings by default. `Date`, bigint, and supported Temporal values can be
  bound directly; reading them as Date, bigint, or Temporal requires an explicit codec choice.
- Use `json(value)` for JSON parameters and `param(array, codec)` for PostgreSQL arrays. Plain
  objects, arrays, and `undefined` are rejected as binds.
- Query values are parameters. Table names, column names, SQL fragments, and lists cannot be
  inserted with `sql` interpolations.

See [values and codecs](docs/values.md) for examples and the full output mapping.

## Documentation

Start with the [documentation index](docs/README.md) or choose a guide:

- [Queries and results](docs/queries.md): tagged SQL, classic queries, row types, Describe, and scripts.
- [Pools, sessions, and transactions](docs/sessions.md): ownership, savepoints, and preparation.
- [Configuration](docs/configuration.md): connection URIs, TLS, authentication, and limits.
- [Streams and COPY](docs/streaming.md) and [notifications](docs/notifications.md).
- [Errors, timeouts, and shutdown](docs/errors.md).
- [API overview and compatibility](docs/public-api.md), including migration notes.

Schema generation and query checking live in [Tenon](https://github.com/kequtech/tenon-orm).
SQL composition and migrations belong to the application or a higher-level library.

For contributors: [development and testing](https://github.com/kequtech/pgclear/blob/main/docs/development.md),
[architecture](https://github.com/kequtech/pgclear/blob/main/docs/architecture.md),
[benchmarks](https://github.com/kequtech/pgclear/tree/main/benchmarks), and [release notes](CHANGELOG.md).
