# Queries and data transfer

[Overview](../README.md) · [Connections](connections.md) · [Values](values.md) · [Reference](reference.md)

## Execute a query

```ts
import { sql } from '@kequtech/pgclear';

const tagged = await pool.query(sql<{ message: string }>`SELECT ${'Hello'} AS message`);
const classic = await pool.queryClassic<{ message: string }>('SELECT $1 AS message', ['Hello']);
```

`sql` produces a frozen tagged [text, values] tuple; each interpolation is one bound value. Keep
interpolations outside quotes/comments. It does not insert identifiers, fragments or lists. For
lists, bind a typed array and use ANY. `query` accepts only this tag's results; strings, handwritten
tuples and statement objects reject before pool acquisition. `queryClassic` accepts text and values,
defaulting to an empty array. Use undefined for values when supplying only the third options argument.

Both execute one statement through the extended protocol without a preliminary Describe or catalog
query. Strings/SQL require valid Unicode without NUL. The parameter limit is 65,535. Keep bound
mutable values unchanged until settlement. Operations start when called; Promise.all on one backend
queues sequential work. No execution method retries automatically.

Results contain readonly rows, ordered fields, command, raw commandTag and rowCount:number|null.
RowCount is command metadata, not always rows.length. `count(*)` is an int8 column and reads as a
string by default. Overflowing command counts reject instead of rounding and retain confirmation.
Object rows require unique names; alias duplicate columns or use positional rows:

```ts
const result = await pool.queryClassic<readonly [number, number]>(
  'SELECT 1 AS value, 2 AS value',
  undefined,
  { rowMode: 'array' },
);
```

Row annotations assert a type; they validate neither SQL nor data. Fields expose name, dataTypeOid,
tableOid, columnAttribute, dataTypeSize, typeModifier and format. OIDs select decoding, not nullability.
Query options are signal, timeoutMs, rowMode and operation-local codecs. Encoders stay independent.

## Describe and scripts

```ts
const metadata = await pool.describe({ text: 'SELECT $1 AS value', parameterTypes: [23] });
await pool.withSession(async (session) => {
  const results = await session.script('SELECT 1; SELECT 2;');
});
```

Describe parses/analyzes one statement without values or execution. It returns parameterTypes and
fields; optional OID hints use zero for inference. PostgreSQL analysis can acquire locks. Application
types, catalog interpretation and schema generation belong to downstream tools.

Scripts use simple protocol, no values, object rows and session-default codecs. They return ordered
result sets or reject without a partial result list. Scripts add no atomic wrapper: explicit commits
can persist effects before a later failure. Use managed transactions for atomic application work.
Scripts exist on held sessions/leases/connections, not pool or transaction callback handles.

## Prepare a statement

```ts
await pool.withSession(async (session) => {
  const statement = await session.prepare('SELECT $1 AS message');
  try {
    const result = await statement.query<{ message: string }>(['Hello']);
  } finally {
    await statement.close();
  }
});
```

Prepare accepts text or {text,parameterTypes}, plus operation options, and creates a named statement.
The handle exposes description, query(values?,options?) and idempotent close(). Parameter counts
must match. It belongs to its exact session/transaction/savepoint and expires with it; a parent handle
cannot execute while a child owns the session. Scope cleanup disposes statements before reuse.
There is no automatic cache or plan-error replay. Use direct/session pooling.

## Stream rows

```ts
await pool.withSession(async (session) => {
  const stream = session.stream<{ id: number }>('SELECT generate_series(1, 1000) AS id', {
    batchSize: 100,
  });
  for await (const row of stream) console.log(row.id);
  console.log(await stream.completion);
});
```

Stream accepts tagged SQL, text, [text,values], or {text,values,parameterTypes}; OID hints must match
value count. It returns immediately with one async consumer, a fields promise, completion and close().
The stream owns the session until consumed/closed. Options add batchSize to normal query options.
maxResultBytes bounds each batch plus metadata; a wide single row can still overflow. Deadlines
include consumer waits.

Completion resolves to {status:'complete',result} or {status:'closed'}. Complete row streams count
all returned rows, while commandTag preserves the server's raw final tag. Early close invents no
final count. Iteration/completion reject on failure, as does metadata if still pending. Waiting only
on completion does not consume rows.

A for-await break awaits portal cleanup and allows later session work. Manual iteration needs
finally/close. Unfinished streams at callback exit cause failure and transactional rollback.

## COPY bytes

```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

await pool.withSession(async (session) => {
  await session.copyFrom(
    'COPY imported_events FROM STDIN WITH (FORMAT csv)',
    createReadStream('events.csv'),
  );
  const output = session.copyTo('COPY imported_events TO STDOUT WITH (FORMAT csv)');
  try {
    await pipeline(output, createWriteStream('export.csv'));
    console.log(await output.completion);
  } finally {
    await output.close();
  }
});
```

This assumes the table and input file exist. COPY accepts text without bound values, and signal/
timeoutMs options. Input is an AsyncIterable of Uint8Array, including a byte-mode Node Readable;
the caller encodes COPY records. Source failures preserve cause as PGCLEAR_COPY_SOURCE; invalid
chunks reject as PGCLEAR_ENCODE. Pulling and writes respect backpressure with bounded cleanup.

Output is a single-consumer byte stream with the same complete/closed distinction. Chunks are not
record boundaries. COPY owns the execution slot; frame/handoff limits do not bound the whole transfer.
Early output close cancels and retires the connection. Use a transaction when COPY must commit
with other statements.
