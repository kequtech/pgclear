# Connections and transactions

[Overview](../README.md) · [Reference](reference.md) · [Errors and shutdown](errors.md)

## Configure a connection

`createPool`, `connect` and `listen` accept a PostgreSQL URI or explicit connection options:

```ts
import { createPool } from '@kequtech/pgclear';

const pool = createPool({
  connectionString: process.env.DATABASE_URL!,
  applicationName: 'worker',
  maxConnections: 10,
});
```

Explicit fields override URI values; undefined fields do not erase them. Unknown keys and null
settings reject. The driver reads no environment variables, .env, service files or pgpass.
`createPool` validates synchronously and connects on demand. `connect` resolves after startup.
[Reference](reference.md#connection-options) lists every option and default.

URI schemes are postgres/postgresql. Supported query keys are host, port, user, password, dbname,
application_name and sslmode; query values override URI components. Percent-encode reserved
characters. Duplicate/unknown keys, fragments and multi-host URIs reject. An absolute host path
selects a Unix socket directory; port selects the socket filename.

Password providers receive `{ host, port, user, database }` for each new physical connection,
including later pool/listener replacements. They may return a promise. Startup fixes UTF8 encoding,
ISO DateStyle, iso_8601 intervals and UTC. Other settings use startupParameters; fixed/reserved
keys, user/database, replication, options, protocol, application_name and `_pq_.` keys reject.
Use applicationName for the application name. Restore subsequent SQL SET changes before pool reuse.

## TLS and authentication

```ts
const pool = createPool({
  connectionString: process.env.DATABASE_URL!,
  tls: { ca: trustedCaPem, serverName: 'db.example.com', channelBinding: 'require' },
});
```

`tls: {}` uses system trust and verifies certificate/hostname. ca accepts PEM text or an array;
client cert/key must be supplied together. Unix-socket TLS requires serverName. Channel binding
is prefer by default, with require/disable alternatives; require needs SCRAM-PLUS. URI sslmode
accepts disable, require or verify-full; the last two both verify trust and hostname. Explicit tls
overrides the URI. There is no unverified fallback. Trust, password, MD5 and SCRAM are supported;
cleartext password authentication requires TLS or a Unix socket.

## Hold a session

| Operation                            | Ownership                                      |
| ------------------------------------ | ---------------------------------------------- |
| pool.query / queryClassic / describe | One operation, automatic release               |
| pool.withSession(callback, options?) | Held callback, automatic release               |
| pool.transaction(callback, options?) | Transaction, automatic commit/rollback/release |
| pool.acquire(options?)               | Lease until release                            |
| connect(options, operationOptions?)  | Standalone connection until close              |

Acquisitions are FIFO and bounded. One physical connection executes operations sequentially;
independent pool calls can use different connections. Streams and child scopes reserve their session.

```ts
const lease = await pool.acquire({ timeoutMs: 1000 });
try {
  await lease.queryClassic('SELECT 1');
} finally {
  await lease.release();
}
```

Acquire options cover acquisition only. `withSession` options cover acquisition and the callback;
a failing callback discards the connection. Release expires the handle, drains admitted operations,
disposes prepared statements and returns only an idle safe connection. `release({ discard: true })`
destroys it. Release is idempotent. Restore temporary tables, session locks and SET changes yourself;
transaction-idle does not mean session state was reset. One-off pool work that leaks BEGIN rejects.

Callback and lease handles expire permanently when their scope ends. A standalone connection,
lease or statement never reconnects itself. The pool may open a new connection for later work.
`info` exposes id/backendPid/serverVersion on held scopes. transactionStatus is the last observed
ReadyForQuery state, not a liveness check. Pool stats include connecting/retiring sessions in total,
so total need not equal idle + leased.

## Transactions and savepoints

```ts
await pool.transaction(
  async (tx) => {
    await tx.queryClassic('CREATE TEMP TABLE example(id integer PRIMARY KEY) ON COMMIT DROP');
    await tx.queryClassic('INSERT INTO example VALUES (1)');
    try {
      await tx.savepoint(async (sp) => {
        await sp.queryClassic('INSERT INTO example VALUES (1)');
      });
    } catch (error) {
      if (!(error instanceof DatabaseError) || error.code !== '23505') throw error;
    }
    await tx.queryClassic('INSERT INTO example VALUES (2)');
  },
  { isolation: 'serializable', timeoutMs: 5000 },
);
```

Import DatabaseError from pgclear. Transaction callbacks return their value after successful commit;
escaping errors roll back. Use each supplied handle and await its work. A root pool call uses another
session outside the transaction. Held idle sessions/connections also provide transaction(). Omitted
isolation/readOnly/deferrable use server defaults. Deferrable true requires serializable + readOnly.

Do not send manual transaction/savepoint boundaries through a managed callback. Catching a statement
error alone does not recover a failed transaction. A failed state or COMMIT returning ROLLBACK rejects
even if the callback returned normally. Accepted work drains before settlement; an unfinished stream
makes a successful callback fail, with rollback in a transaction.

Savepoint callbacks can nest and inherit the parent deadline. They have no separate options argument.
Use the child while it owns the session; parent/sibling calls reject PGCLEAR_BUSY. Successful recovery
restores the parent; failed recovery prevents a safe commit. Work and cleanup errors are preserved.
Cancellation expires scopes even if JavaScript keeps running. [Outcome rules](errors.md) determine
what can be concluded after a failure; retries and idempotency belong to the caller.

## Pooling proxies

PgBouncer session and transaction pooling are tested. A transaction pins its backend, while a held
proxy session need not keep the same PostgreSQL backend across transactions. Use direct/session
pooling for session advisory locks, explicit prepared statements and LISTEN. The tested transaction
proxy disables named statements with max_prepared_statements=0. Ordinary unnamed queries, managed
transactions, savepoint recovery and cancellation are covered. Exact native fixtures are described
in the repository's [contributing guide](https://github.com/kequtech/pgclear/blob/main/CONTRIBUTING.md#compatibility-tests).
