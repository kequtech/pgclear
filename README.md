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
user input into the query string. `queryClassic` accepts SQL text and values; `query` also supports
[tagged templates and other query forms](docs/public-api.md#query-execution-and-results).

The pool opens connections as needed. In a long-running application, reuse it across queries and
close it when the application shuts down.

Returned records are in `result.rows`. Results also include column information, the server's command
tag and a `rowCount` of type `bigint | null`.

## Values and types

Large integers are returned as `bigint`; decimals and dates/times stay strings. For JSON and array
parameters, use the explicit `json` and `param` helpers. See [values and type conversions](docs/public-api.md#codecs-and-parameters)
for examples and the full PostgreSQL-to-JavaScript mapping.

For TypeScript projects, [generateDefinitions](docs/public-api.md#schema-type-generation) produces
row, insert and update types for database tables, with relationships and indexes in comments.
Query result annotations are trusted declarations, not runtime validation.

The API also provides transactions, savepoints, prepared statements, row streaming, COPY and
notification listeners. SQL composition, query checking and migrations remain application or
higher-level library responsibilities.

## Documentation

- [API and usage](docs/public-api.md)
- [Release notes](CHANGELOG.md)
- [Development and testing](https://github.com/kequtech/pgclear/blob/main/docs/development.md)
