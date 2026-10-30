# Queries and results

[Documentation](README.md) · [Values and codecs](values.md) · [Sessions and transactions](sessions.md)

Use `query` for tagged SQL or `queryClassic` for SQL text with numbered placeholders. Both methods
are available on pools, connections, leases, sessions, transactions, and savepoints.

## Tagged SQL

```ts
import { sql } from '@kequtech/pgclear';

const id = 42;
const result = await pool.query(sql<{ id: number }>`SELECT ${id}::integer AS id`);
console.log(result.rows[0]?.id); // 42
```

`sql` produces a frozen `[text, values]` tuple. The example becomes `SELECT $1::integer AS id` with
`[42]` as its values. The tag builds a query; `pool.query(...)` executes it.

`::integer` is a PostgreSQL cast that requests an integer result here, not pgclear syntax.
Casts are optional when PostgreSQL can infer the desired type, for example from a table column.

Every interpolation is one bound value. Put it outside SQL quotes and comments. Interpolations
cannot insert identifiers, fragments, nested tagged queries, or lists. For a list of integers,
bind a [typed array](values.md#postgresql-arrays) and use `= ANY($1::integer[])`. Choose dynamic SQL
structure in application code from trusted choices.

`query` accepts only a query produced by this tag. Plain strings, manually constructed tuples, and
statement objects reject with `PGCLEAR_ENCODE`, including in JavaScript. Pool tag validation happens
before connection acquisition.

## SQL text and placeholders

```ts
const result = await pool.queryClassic<{ id: number }>('SELECT $1::integer AS id', [42]);
const unbound = await pool.queryClassic('SELECT current_database()');
const bounded = await pool.queryClassic('SELECT 1', undefined, { timeoutMs: 1000 });
```

`queryClassic(text, values?, options?)` defaults to an empty values array. `$1` refers to the first
value, `$2` to the second, and so on. Send input as values instead of concatenating it into SQL.
Use an SQL cast or [`param`](values.md#explicit-parameters) if PostgreSQL cannot infer a type.

Both query methods execute one statement using PostgreSQL's extended protocol. Ordinary queries do
not run a separate preliminary Describe or catalog query. SQL and text parameters must be valid
Unicode without NUL. At most 65,535 parameters are accepted. Keep mutable bound values unchanged
until the operation settles.

Operations start when called. On a single connection, concurrent calls queue and execute in order;
`Promise.all` does not make that backend execute queries in parallel. Independent pool calls can
use different connections. Queries and scripts are never retried automatically.

## Results and row types

| Property     | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `rows`       | Readonly array of decoded rows; empty for commands without returned rows |
| `fields`     | Ordered column metadata                                                  |
| `command`    | Command name, such as `SELECT` or `INSERT`                               |
| `commandTag` | Full server tag, such as `INSERT 0 1`                                    |
| `rowCount`   | Command count as `number                                                 | null`; not necessarily the number of returned rows |

Rows are objects keyed by column name. Without a row annotation, each field value has TypeScript
type `unknown`. `queryClassic<Row>` and `sql<Row>` assert the row type; they do not inspect the SQL,
validate rows, or change decoding. Include SQL NULL in your annotation where appropriate.

Use aliases for duplicate column names, or request positional rows:

```ts
const result = await pool.queryClassic<readonly [number, number]>(
  'SELECT 1 AS value, 2 AS value',
  undefined,
  { rowMode: 'array' },
);
console.log(result.rows[0]); // [1, 2]
console.log(result.fields.map((field) => field.name)); // ['value', 'value']
```

Duplicate names in object mode reject during decoding. Array mode preserves every column in order.
For tagged queries, use `sql<readonly [number, number]>` and `{ rowMode: 'array' }`.

Each `Field` contains `name`, `dataTypeOid`, `tableOid`, `columnAttribute`, `dataTypeSize`,
`typeModifier`, and `format`. A computed column may have no table origin. Type OIDs select
[result decoders](values.md); they do not describe SQL nullability.

`count(*)` returns an int8 column, which is a string by default. This is separate from `rowCount`:

```ts
const result = await pool.queryClassic<{ total: string }>(
  'SELECT count(*) AS total FROM generate_series(1, 3)',
);
console.log(result.rows[0]?.total); // '3'
console.log(result.rowCount); // 1
```

Command counts above `Number.MAX_SAFE_INTEGER` reject with `PGCLEAR_RESULT_LIMIT` and retire the
connection instead of rounding. The error preserves confirmation of the command.

## Query options

Both query methods accept `signal`, `timeoutMs`, `rowMode`, and `codecs`. `rowMode` defaults to
`'object'`. A `codecs` registry changes result decoding for that operation; input encoders stay
independent. See [per-query codecs](values.md#per-query-codecs) and [deadlines](errors.md#deadlines).

## Describe without executing

```ts
const description = await pool.describe({
  text: 'SELECT $1::integer AS value',
  parameterTypes: [23],
});
console.log(description.parameterTypes); // [23], the int4 OID
console.log(description.fields[0]?.name); // value
```

`describe(textOrStatement, options?)` returns `{ parameterTypes, fields }`. It parses and analyzes
one statement without executing it, so PostgreSQL can still take analysis locks and report errors.
Type hints are optional OIDs; zero requests server inference. Describe accepts no bound values and
does not infer nullability or application types. Options are `signal` and `timeoutMs`.

## Multi-statement scripts

```ts
await pool.withSession(async (session) => {
  const results = await session.script('SELECT 1 AS first; SELECT 2 AS second;');
  console.log(results.map((result) => result.rows));
});
```

`script(text, options?)` is available on connections, leases, and session callbacks. It uses the
simple protocol, takes no bound values, and returns ordered result sets using the session's default
codecs and object rows. Options are `signal` and `timeoutMs`.

Scripts follow PostgreSQL's transaction rules. pgclear adds no atomic wrapper. Explicit transaction
boundaries in a script can commit effects before a later statement fails. On failure the promise
rejects rather than returning a partial result list. Use managed [transactions](sessions.md#transactions)
for application work that must commit together.
