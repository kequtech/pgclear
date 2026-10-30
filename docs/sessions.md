# Pools, sessions, and transactions

[Documentation](README.md) · [Queries](queries.md) · [Configuration](configuration.md)

A session is one held connection. Keeping related operations on that connection matters for
transactions, temporary tables, session settings, locks, prepared statements, and streams.

## Choose how to hold a connection

| API                                                | Holds a connection for         | Cleanup                           |
| -------------------------------------------------- | ------------------------------ | --------------------------------- |
| `pool.query`, `pool.queryClassic`, `pool.describe` | One operation                  | Automatic release                 |
| `pool.withSession(callback)`                       | The callback                   | Automatic release                 |
| `pool.transaction(callback)`                       | One transaction                | Commit/rollback and release       |
| `pool.acquire()`                                   | Until you release the lease    | `lease.release()` in `finally`    |
| `connect()`                                        | Until you close the connection | `connection.close()` in `finally` |

Pools open connections on demand, up to `maxConnections`. Waiting acquisitions are FIFO and bounded
by `maxWaiting` and `acquireTimeoutMs`. Calls on one connection execute sequentially. Streams and
child transaction scopes reserve the session and reject competing calls with `PGCLEAR_BUSY`.

## A held session

```ts
await pool.withSession(async (session) => {
  await session.queryClassic('CREATE TEMP TABLE example (id integer)');
  try {
    await session.queryClassic('INSERT INTO example VALUES ($1)', [42]);
    const result = await session.queryClassic<{ id: number }>('SELECT id FROM example');
    console.log(result.rows); // [{ id: 42 }]
  } finally {
    await session.queryClassic('DROP TABLE example');
  }
});
```

`withSession(callback, options?)` holds one connection without starting a transaction. Its callback
returns your result to the caller. Options are `signal` and `timeoutMs`, covering acquisition and
the whole callback. A failing callback discards the connection.

Session state is not automatically reset on release. Restore `SET` changes, temporary tables, and
session advisory locks before returning a session to the pool, or discard an explicit lease.
One-off pool queries must leave transaction state idle; `pool.queryClassic('BEGIN')` rejects with
`PGCLEAR_SESSION_STATE`. Session settings can still leak even when the session is transaction-idle.

Await work inside callbacks. Session, transaction, and savepoint handles expire permanently when
their scope ends. Keeping a reference does not extend its lifetime.

## Explicit leases and standalone connections

```ts
const lease = await pool.acquire({ timeoutMs: 1000 });
try {
  await lease.queryClassic('SELECT 1');
} finally {
  await lease.release();
}
```

`acquire` options bound acquisition only. After acquisition, set deadlines on individual operations
or use a callback scope. `release()` expires the lease immediately, drains accepted work, disposes
its prepared statements, and returns only a safely idle connection. `release({ discard: true })`
destroys the connection. Release is idempotent. Unsafe state or uncertain cleanup also prevents reuse.

For a connection outside a pool:

```ts
import { connect } from '@kequtech/pgclear';

const connection = await connect(process.env.DATABASE_URL!, { timeoutMs: 1000 });
try {
  await connection.queryClassic('SELECT 1');
} finally {
  await connection.close();
}
```

The second `connect` argument bounds startup only. No connection, lease, or prepared handle reconnects
itself. A pool may open a fresh connection for later work.

## Transactions

```ts
const transferred = await pool.transaction(
  async (tx) => {
    await tx.queryClassic('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [10, 1]);
    await tx.queryClassic('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [10, 2]);
    return 10;
  },
  { isolation: 'serializable', timeoutMs: 5000 },
);
```

This assumes an `accounts` table. A successful callback commits and returns its value. A thrown
error rolls back and rejects. Use the callback's `tx` for every operation; calling the pool inside
it can acquire another connection outside the transaction.

`session.transaction` and `connection.transaction` provide the same managed transaction on an
already held, idle session. The parent handle is reserved until the transaction and cleanup finish.

| Transaction option    | Meaning                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `isolation`           | `'read committed'`, `'repeatable read'`, or `'serializable'`           |
| `readOnly`            | Explicit `READ ONLY` or `READ WRITE`                                   |
| `deferrable`          | Requires `isolation: 'serializable'` and `readOnly: true` when enabled |
| `signal`, `timeoutMs` | Whole-scope cancellation/deadline, including acquisition on a pool     |

Omitted transaction settings use PostgreSQL's session defaults. Do not issue manual `BEGIN`,
`COMMIT`, `ROLLBACK`, or savepoint boundaries through a managed callback. A failed transaction or
COMMIT returning ROLLBACK is an error even if the callback returns normally. Catching a statement
error does not by itself restore a failed PostgreSQL transaction.

Accepted work drains before commit or rollback. An unfinished stream makes a successful callback
fail and roll back. Cancellation expires the handle immediately; JavaScript code may continue, but
late database calls through it reject. Managed rollback can leave a connection safe to reuse.

Transactions are not retried automatically. Serialization failures and deadlocks require an
application retry policy for the whole transaction. A lost COMMIT response is
[an unknown outcome](errors.md#outcomes-and-retries), so blindly repeating writes can duplicate them.

## Savepoints

A savepoint lets you roll back part of a transaction and keep the parent transaction usable:

```ts
import { DatabaseError } from '@kequtech/pgclear';

await pool.transaction(async (tx) => {
  await tx.queryClassic('CREATE TEMP TABLE example (id integer PRIMARY KEY) ON COMMIT DROP');
  await tx.queryClassic('INSERT INTO example VALUES (1)');
  try {
    await tx.savepoint(async (sp) => {
      await sp.queryClassic('INSERT INTO example VALUES (1)');
    });
  } catch (error) {
    if (!(error instanceof DatabaseError) || error.code !== '23505') throw error;
  }
  await tx.queryClassic('INSERT INTO example VALUES (2)');
});
```

`tx.savepoint(callback)` releases the savepoint on success and rolls back to it on failure. Use the
supplied child handle while inside the callback; parent or sibling calls reject `PGCLEAR_BUSY`.
Savepoints can nest and inherit their parent's deadline. They have no separate options argument.
A successful recovery restores the parent; failed recovery makes it unsafe to commit. Cleanup
failures can be combined with the original error in an `AggregateError`.

## Prepared statements

```ts
await pool.withSession(async (session) => {
  const prepared = await session.prepare('SELECT $1::integer AS value');
  try {
    console.log(prepared.description.parameterTypes); // [23]
    const result = await prepared.query<{ value: number }>([42]);
    console.log(result.rows); // [{ value: 42 }]
  } finally {
    await prepared.close();
  }
});
```

`prepare(textOrDescription, options?)` creates a named server statement and returns a handle with
`description`, `query(values?, options?)`, and idempotent `close()`. It also accepts
`{ text, parameterTypes }` for OID hints. Prepare options are `signal` and `timeoutMs`; execution
accepts the usual query options. Parameter counts must match the prepared description.

A prepared handle belongs to the exact session, transaction, or savepoint scope that created it.
It expires with that scope, and parent handles cannot execute while a child owns the session.
Cleanup disposes statements before reuse; uncertain disposal discards the connection. There is no
automatic statement cache or retry after plan errors. Use a direct or session-pooled connection;
see [PgBouncer limits](configuration.md#pgbouncer).

## Session information and pool statistics

Held sessions expose `info: { id, backendPid, serverVersion }`. `id` identifies the driver's session;
`backendPid` identifies the server backend reported at startup. With transaction pooling, it does
not promise a stable PostgreSQL backend across transactions.

`transactionStatus` is the last observed ReadyForQuery state: `'idle'`, `'transaction'`, or `'failed'`.
It is not a liveness probe. All executors also expose their immutable default `codecs` registry.

`pool.stats` returns a snapshot with `total`, `idle`, `leased`, and `waiting`. `total` includes
connecting and retiring sessions, so it need not equal `idle + leased`. See
[shutdown](errors.md#shutdown) before disposing a long-running application's pool.
