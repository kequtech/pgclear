# pgclear

A standalone TypeScript PostgreSQL driver built around explicit session ownership,
predictable failure handling, and first-class protocol operations. Tenon is the first intended
consumer; pgclear has no runtime dependency on Tenon.

**Status: M5 implemented locally; not ready for production or publication.** Native TypeScript
declarations cover connections, pools, leases, transaction/savepoint scopes, immutable codecs,
explicit typed/JSON parameters, description, scripts, scope-owned prepared statements, portal row
streams and byte COPY.
Notifications remain planned. An isolated Tenon 0.3.1 adapter trial uses the native driver contracts;
its evidence and remaining adoption work are recorded in [docs/tenon-trial.md](docs/tenon-trial.md).
`private: true` prevents accidental publication until the implementation and release gates are ready.

```ts
import { connect, sql } from '@kequtech/pgclear';

const connection = await connect({ connectionString: process.env.DATABASE_URL! });
try {
  const result = await connection.query(sql<{ value: number }>`SELECT ${42}::integer AS value`);
  // Classic callers use the same execution and conversion path.
  await connection.queryClassic<{ value: number }>('SELECT $1::integer AS value', [42]);
  console.log(result.rows[0]?.value);
} finally {
  await connection.close();
}
```

`sql` binds values only; it returns an immutable `[text, values]` tuple. `query` also accepts that
classic tuple or the existing `{ text, values, parameterTypes }` statement form. Row annotations
are trusted TypeScript assertions. Type generation and query checking belong in Tenon.

`prepare` is available on held sessions and transaction/savepoint callbacks. Its handle exposes
`description`, `query(values, options)` and idempotent `close()`. Handles expire with the exact
creating scope; parent handles are blocked while a child owns the session. Accepted executions drain
before Close, and names are disposed before session reuse. There is no automatic cache or retry.

`session.stream(query, { batchSize: 100 })` returns a single-consumer async iterable with `fields`,
`completion` and `close()`. It owns the session until consumed or closed; `for await` early exit
awaits cleanup. Streams buffer one bounded batch and also work in transaction/savepoint callbacks.
Completion preserves the backend tag/count; count iterated rows when a stream-wide total is needed.

`session.copyFrom(text, byteSource)` accepts an async iterable or Node Readable of Uint8Array chunks;
`session.copyTo(text)` returns a byte stream with completion and close. Both own the session while
active and support transaction/savepoint scopes. Input pulls and writes obey backpressure; output
pauses for slow consumers. CSV/binary record encoding stays with the caller. Early COPY output close
uses cancellation and retires the connection.

The connection supports TCP/Unix sockets, verified TLS, trust/password/MD5/SCRAM authentication,
SCRAM channel binding, sequential extended queries, scalar results, field metadata, and bounded
startup/close. Codecs preserve bigint/numeric precision inside arrays, and `json(null)` explicitly
binds JSON null. `describe` returns parameter/field metadata without Execute; `script` returns ordered
result sets using PostgreSQL transaction semantics. Active cancellation uses a separate transport and retires the original session. Managed transactions
validate PostgreSQL state and COMMIT tags; lost COMMIT responses have an explicit unknown outcome. A client-side
timeout or disconnect does not establish that a write rolled back.

The canonical specifications and implementation plan live in [docs/](docs/README.md). Start with
the [public API](docs/public-api.md), [architecture](docs/architecture.md), and
[implementation plan](docs/implementation-plan.md). Accepted choices are recorded in the
[decision log](docs/decisions.md).

Node.js 24 and npm are the development foundations. `npm ci` followed by `npm run check` checks types,
formatting, packets/authentication, packed consumers, and real database workflows. Integration tests
require `PGCLEAR_TEST_DATABASE_URL` naming an explicit `_test` database; the test harness also uses
`psql` to compare Unicode authentication with libpq. Database-independent tests run with
`npm run test:unit`. See [development](docs/development.md) for setup and verification evidence.
