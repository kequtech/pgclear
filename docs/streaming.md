# Streams and COPY

[Documentation](README.md) · [Sessions](sessions.md) · [Limits](configuration.md#connection-limits)

A buffered query collects its rows before resolving. A row stream fetches batches as you consume
it. COPY transfers raw bytes for PostgreSQL bulk import/export. Both need a held connection:
use `pool.withSession`, a lease, a standalone connection, or a transaction/savepoint handle.

## Stream rows

```ts
await pool.withSession(async (session) => {
  const stream = session.stream<{ id: number }>('SELECT generate_series(1, 1000) AS id', {
    batchSize: 100,
  });
  for await (const row of stream) {
    console.log(row.id);
  }
  const completion = await stream.completion;
  if (completion.status === 'complete') console.log(completion.result.rowCount); // 1000
});
```

`stream(statement, options?)` returns a `RowStream` immediately. Inputs can be tagged SQL, SQL text,
`[text, values]`, or `{ text, values, parameterTypes }`. In a statement object, supplied OID hints must
match the values array length; zero requests inference. A stream executes one statement.

Options are `batchSize` (integer from 1 through 2,147,483,647, default `100`), `rowMode`, `codecs`, `signal`, and
`timeoutMs`. Row decoding and type annotations work like ordinary queries. `stream.fields` is a
promise of ordered column metadata. `maxResultBytes` bounds each batch plus metadata, rather than
the whole stream. Choose a smaller batch for wide rows; one oversized row can still exceed a limit.
Deadlines include time spent waiting for the consumer.

The stream owns the session's execution slot and allows one consumer. Consume or close it before
running another operation. Awaiting `completion` alone does not consume rows and may wait forever.

## Stop early and clean up

A `for await` break closes the stream and awaits portal cleanup:

```ts
await pool.withSession(async (session) => {
  const stream = session.stream<{ id: number }>('SELECT generate_series(1, 1000) AS id');
  for await (const row of stream) {
    if (row.id === 5) break;
  }
  console.log(await stream.completion); // { status: 'closed' }
  await session.queryClassic('SELECT 1');
});
```

If you manually call an iterator's `next()`, use `try/finally` and `await stream.close()` when
stopping early. Leaving an unconsumed stream at callback exit triggers cleanup and makes an
otherwise successful callback fail. In a transaction it causes rollback.

`completion` resolves to one of:

| Completion                       | Meaning                                          |
| -------------------------------- | ------------------------------------------------ |
| `{ status: 'complete', result }` | Fully consumed; `result` has command metadata    |
| `{ status: 'closed' }`           | Closed early; no final command/count is invented |

For a fully consumed row result, `result.rowCount` counts all returned rows across all batches,
including zero. `commandTag` is the raw server tag, which may count only the final portal batch.
Commands without row results retain their affected-row count or null. Iteration and completion
reject on failure; pending metadata also rejects if it was not delivered before the failure.

## COPY input

```ts
import { createReadStream } from 'node:fs';

await pool.withSession(async (session) => {
  await session.queryClassic('CREATE TEMP TABLE imported_events (id integer, name text)');
  try {
    const result = await session.copyFrom(
      'COPY imported_events (id, name) FROM STDIN WITH (FORMAT csv)',
      createReadStream('events.csv'),
    );
    console.log(result.rowCount);
  } finally {
    await session.queryClassic('DROP TABLE imported_events');
  }
});
```

This assumes `events.csv` contains CSV rows such as `1,opened`. `copyFrom(text, source, options?)`
accepts an async iterable of `Uint8Array`, including a Node Readable byte stream, and resolves to
`CommandResult`. Do not set a text encoding on the source. pgclear pulls input with backpressure;
the caller encodes the CSV, text, or binary COPY records.

Source failures reject with `PGCLEAR_COPY_SOURCE` and preserve the cause. Invalid chunks use
`PGCLEAR_ENCODE`. Source/iterator cleanup is bounded. Use a managed transaction if import work must
commit together with other statements.

## COPY output

```ts
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

await pool.withSession(async (session) => {
  const output = session.copyTo('COPY (SELECT generate_series(1, 10)) TO STDOUT WITH (FORMAT csv)');
  try {
    await pipeline(output, createWriteStream('numbers.csv'));
    const completion = await output.completion;
    if (completion.status === 'complete') console.log(completion.result.rowCount); // 10
  } finally {
    await output.close();
  }
});
```

`copyTo(text, options?)` returns a single-consumer async byte stream with `completion` and `close()`.
It uses the same complete/closed distinction as row streams. Consume it with `for await` or a byte
stream destination that respects backpressure. Chunk boundaries are not record boundaries.

COPY methods accept SQL text, with no bound values; options are `signal` and `timeoutMs`. Use
`FROM STDIN`/`TO STDOUT` for client byte transfer. Byte/frame limits bound handoff rather than the
whole transfer. COPY owns the session until it settles. Early output close cancels and retires the
connection, so it cannot be reused for a later query.
