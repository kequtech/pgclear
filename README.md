# pgclear

A PostgreSQL driver for Node.js 24+ and ESM JavaScript/TypeScript, with no runtime dependencies.
It provides queries, connection pools, transactions, prepared statements, streaming, COPY,
notifications and schema type generation. PostgreSQL 16 and 18 are tested.

```ts
import { createPool } from '@kequtech/pgclear';

const pool = createPool({ connectionString: process.env.DATABASE_URL! });
try {
  const result = await pool.queryClassic<{ value: number }>('SELECT $1::integer AS value', [42]);
  console.log(result.rows[0]?.value);
} finally {
  await pool.close();
}
```

`queryClassic(text, values, options)` accepts finished SQL and bound values. `query` also accepts
plain SQL, a `[text, values]` tuple, a statement object, or the `sql` value-binding tag. All forms
use the same execution path and work for applications and libraries.

Results contain `rows`, `fields`, `command`, `commandTag` and `rowCount`. Counts are `bigint | null`.
TypeScript row annotations are caller assertions; they do not validate query results.

Large integers become `bigint`; decimals and temporal values stay strings; bytes become
`Uint8Array`. JSON uses `JSON.parse`. Objects, arrays and `Date` are not implicit parameter values:
use `json`, `param` or explicitly encoded text. See the [type mapping](docs/public-api.md#codecs-and-parameters).

Use `generateDefinitions` to produce `Database[table]['row' | 'insert' | 'update']` types, with
relationships and indexes in comments. SQL composition, query checking, migrations and file output
belong to the caller.

- [API and usage](docs/public-api.md)
- [Release notes](CHANGELOG.md)
- [Development and testing](https://github.com/kequtech/pgclear/blob/main/docs/development.md)

Version 0.1.0 is prepared but not published. To try a checkout, run `npm ci` and `npm pack`, then
install the generated `.tgz` in your application. The repository currently requires access.
