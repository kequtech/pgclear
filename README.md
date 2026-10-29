# pgclear

A PostgreSQL driver for JavaScript and TypeScript on Node.js 24+. It uses ES modules and has no
runtime dependencies. Tested on PostgreSQL 16 and 18.

## Install

```sh
npm install @kequtech/pgclear
```

## Run a query

Set `DATABASE_URL` to your PostgreSQL connection string, then create a pool:

```ts
import { createPool } from '@kequtech/pgclear';

const pool = createPool({ connectionString: process.env.DATABASE_URL! });
try {
  const text = 'SELECT $1 AS message';
  const values = ['Hello, PostgreSQL!'];

  const result = await pool.queryClassic(text, values);
  console.log(result.rows[0]?.message); // Hello, PostgreSQL!
} finally {
  await pool.close();
}
```

`$1` refers to the first value in the array. Pass values separately from SQL rather than inserting
user input into the query string. `queryClassic` accepts SQL text and an optional values array. Use `query` with the
[`sql` template tag](docs/public-api.md#query-execution-and-results) to bind interpolated values.

The pool opens connections as needed. In a long-running application, reuse it across queries and
close it when the application shuts down.

Returned records are in `result.rows`. Results also include column information, the server's command
tag and a `rowCount` of type `number | null`.

## Values and types

Large integers (`int8`/`bigserial`) and decimals are returned as strings to preserve precision.
Dates and times also stay strings. Use the explicit `json` and `param` helpers for JSON and array
parameters. See [values and type conversions](docs/public-api.md#codecs-and-parameters) for examples
and the full PostgreSQL-to-JavaScript mapping.

Date, bigint and supported Temporal values bind directly. Opt-in codecs can return bigint, Date,
Temporal or application-defined values; [codec representation metadata](docs/public-api.md#custom-representations)
keeps generated output types aligned with the selected decoders.

Schema generation and query checking belong to [Tenon](https://github.com/kequtech/tenon-orm).
Pgclear 0.3.0 removes `generateDefinitions` and `GenerateOptions`; see the
[migration notes](docs/public-api.md#schema-generation-migration). Query result annotations remain
trusted declarations, not runtime validation.

The API also provides transactions, savepoints, prepared statements, row streaming, COPY and
notification listeners. SQL composition, query checking and migrations remain application or
higher-level library responsibilities.

## Documentation

- [API and usage](docs/public-api.md)
- [Benchmarks](https://github.com/kequtech/pgclear/tree/main/benchmarks)
- [Compatibility policy](docs/public-api.md#compatibility)
- [Release notes](CHANGELOG.md)
- [Development and testing](https://github.com/kequtech/pgclear/blob/main/docs/development.md)
