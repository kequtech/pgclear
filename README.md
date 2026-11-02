# pgclear

Standalone PostgreSQL driver for Node.js 24+ and TypeScript. ESM, no runtime dependencies.
Queries, transactions, streams, COPY and notifications use explicit connection ownership.

```sh
npm install @kequtech/pgclear
```

```ts
import { createPool, sql } from '@kequtech/pgclear';

const pool = createPool({ connectionString: process.env.DATABASE_URL! });
try {
  const result = await pool.query(sql<{ message: string }>`SELECT ${'Hello, pgclear!'} AS message`);
  console.log(result.rows[0]?.message);
} finally {
  await pool.close();
}
```

Load configuration before creating the pool. The driver does not read environment files. A server
reuses a pool; transactions and held sessions reserve one connection. There are no automatic query
or transaction retries. Result types are declarations, not runtime validation.

| Task                                                     | Documentation                          |
| -------------------------------------------------------- | -------------------------------------- |
| Execute SQL, prepare statements, stream rows or use COPY | [Queries](docs/queries.md)             |
| Configure and own pools, sessions and transactions       | [Connections](docs/connections.md)     |
| Encode parameters and select result representations      | [Values and codecs](docs/values.md)    |
| Subscribe to LISTEN/NOTIFY channels                      | [Notifications](docs/notifications.md) |
| Handle outcomes, cancellation and shutdown               | [Errors](docs/errors.md)               |
| Look up methods, options, defaults and error codes       | [Reference](docs/reference.md)         |

The guides and [changelog](CHANGELOG.md) ship with the package. Int8, decimal and temporal outputs
are strings by default; JSON and array parameters require explicit encoders. Check value mappings
before choosing application types.

pgclear owns transport, scopes and conversion. The optional
[pgclear-jobs](https://github.com/kequtech/pgclear-jobs) package adds durable jobs;
[Tenon](https://github.com/kequtech/tenon-orm) adds SQL composition, ORM guards and schema tooling.
Neither is required to use this driver.

Maintainers: [contributing](https://github.com/kequtech/pgclear/blob/main/CONTRIBUTING.md),
[architecture](https://github.com/kequtech/pgclear/blob/main/ARCHITECTURE.md),
[benchmarks](https://github.com/kequtech/pgclear/tree/main/benchmarks).
