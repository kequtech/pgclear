# Notifications

[Documentation](README.md) · [Configuration](configuration.md) · [Shutdown](errors.md#shutdown)

`listen` opens a dedicated connection, registers LISTEN channels, and calls your handler for
NOTIFY messages. It does not borrow a connection from a query pool.

```ts
import { listen } from '@kequtech/pgclear';

const listener = await listen(process.env.DATABASE_URL!, {
  channels: ['jobs_changed'],
  onNotification: ({ channel, payload, backendPid }) => {
    console.log(channel, payload, backendPid);
  },
  onStatus: (status) => console.log(status.state, status.generation),
  reconnect: true,
});

try {
  // The promise above resolves after LISTEN registration is complete.
  await pool.queryClassic('SELECT pg_notify($1, $2)', ['jobs_changed', 'ready']);
  // Keep the listener open for as long as the application needs notifications.
} finally {
  await listener.close();
}
```

The example assumes an existing query pool. `pg_notify` is sent over a separate connection; in a
transaction, delivery follows commit. For a long-running application, close the listener during
application shutdown rather than after sending one notification.

## Listener options

The first argument is a URI or `ConnectionOptions`. The second argument contains:

| Option           | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `channels`       | Required initial channel array; may be empty; duplicates are removed |
| `onNotification` | Required handler receiving `{ channel, payload, backendPid }`        |
| `onStatus`       | Optional handler for status changes                                  |
| `reconnect`      | Retry after an established connection is lost; default `false`       |
| `timeoutMs`      | Deadline for initial readiness, including registration               |
| `signal`         | Cancellation for the entire listener lifetime                        |

Channel names are quoted as SQL identifiers and checked against the server's identifier length
limit. Handlers are not awaited and provide no backpressure. Exceptions and rejected promises from
observers are isolated from driver outcomes; handle asynchronous application work and its failures
explicitly.

## Change channel membership

Use one listener for a changing set of channels:

```ts
import { listen } from '@kequtech/pgclear';

const listener = await listen(process.env.DATABASE_URL!, {
  channels: [],
  reconnect: true,
  onNotification: ({ channel, payload }) => console.log(channel, payload),
});
try {
  await listener.subscribe('jobs_changed', { timeoutMs: 5000 });
  // LISTEN is acknowledged; notifications for this channel can now be received.
  await pool.queryClassic('SELECT pg_notify($1, $2)', ['jobs_changed', 'ready']);
  await listener.unsubscribe('jobs_changed');
  // The dedicated connection stays open with no subscriptions.
  await listener.subscribe('other_jobs');
} finally {
  await listener.close();
}
```

`subscribe(channel, options?)` and `unsubscribe(channel, options?)` return promises that resolve
only after the requested membership is acknowledged on the current connection. An already-present
subscription or already-absent unsubscription also succeeds. These are set operations, not reference
counts: two subscribes followed by one unsubscribe removes the channel. Applications own subscriber
reference counts, authorization, and notification routing.

Concurrent calls execute in invocation order. For example, subscribing and then unsubscribing the
same channel leaves it absent when both promises resolve. Notifications may arrive before a
subscribe promise resolves and until an unsubscribe resolves. Asynchronous application handlers
that already started can continue after unsubscription.

The same validation and identifier quoting apply to initial and dynamic channels. Each method
accepts a single channel name; use several calls for several channels. Empty membership keeps the
connection open so it can be subscribed again later. Membership changes do not increment the
connection generation or emit a new connected status.

Options are `signal` and `timeoutMs`, covering queueing, reconnect waits, validation, and server
acknowledgement. A queued timeout/abort rejects without changing membership. Cancellation after
dispatch retires the connection to avoid leaving uncertain server registration behind. Previously
acknowledged membership is retained for reconnect; the cancelled change is not retained. Without
`reconnect: true`, this connection retirement closes the listener. Close rejects pending membership
operations with `PGCLEAR_CLOSED` and disposes in-flight registration without waiting for its server
acknowledgement. Calls made after close reject too.

## Disconnects and delivery gaps

`listener.status` exposes the current state. Each status includes a `generation`; every successful
registration, including an empty membership, increments it. The state is one of:

- `connected`, with `session` information.
- `disconnected`, with an `error`.
- `reconnecting`, with an `attempt` number.
- `closed`, after permanent shutdown.

Reconnect is opt-in and uses exponential backoff with jitter, capped at 30 seconds. It opens a new
connection and restores the last acknowledged channel set. Changes requested during reconnect
wait in invocation order, then execute after that restoration. A change interrupted by transport
loss remains queued and waits for acknowledgement on a replacement connection, unless cancelled,
expired, or closed. Validation/server errors on a usable connection reject only that change.
Initial connection or registration failure rejects `listen`; it does not start background retries.
Without reconnect, a lost connection closes the listener.

Notifications missed during a disconnect are not replayed. Treat messages as signals to inspect
persistent application state when reliable processing matters. Use status/generation changes to
notice a possible gap and reconcile that state.

Use direct PostgreSQL or PgBouncer session pooling. Transaction pooling cannot preserve LISTEN
registration. `listener.close(options?)` permanently stops connections and retries; it is independent
of `pool.close()` and accepts the same shutdown timeout option.

## Shared consumer ownership

The complete [SharedListener example](../examples/shared-listener.ts) is application code, not a
new driver API. Copy it into your application as `shared-listener.ts` and compile it with your
TypeScript project. Its source ships in the package and is typechecked and exercised by the tests.

Keep shared connection settings separate from pool policy:

```ts
import { createPool, type ConnectionOptions } from '@kequtech/pgclear';
import { SharedListener } from './shared-listener.js';

const connection: ConnectionOptions = { connectionString: process.env.DATABASE_URL! };
const pool = createPool({ ...connection, maxConnections: 10, acquireTimeoutMs: 5000 });
const notifications = new SharedListener(connection);
```

A dedicated listener accepts `ConnectionOptions`, not `PoolOptions`. If reusing an existing pool
options object, remove `maxConnections`, `maxWaiting`, `acquireTimeoutMs`, `idleTimeoutMs`, and
`maxLifetimeMs` before passing it to `listen`. TypeScript's structural typing alone does not remove
those properties at runtime; unknown connection options reject.

In the example, each channel has one readiness promise and a set of subscribers. The set size is
its reference count. Repeated subscriptions with the same callbacks still have distinct identities.
Each returned handle exposes `ready` and idempotent `release()`:

```ts
const subscriber = {
  onNotification: ({ payload }: { payload: string }) => console.log(payload),
  onDisconnect: (error: unknown) => console.error('Reopen and reconcile this subscriber:', error),
};
const first = notifications.subscribe('jobs_changed', subscriber);
const second = notifications.subscribe('jobs_changed', subscriber);
try {
  await Promise.all([first.ready, second.ready]); // The same readiness promise.
  await first.release(); // One subscriber remains; no UNLISTEN.
  const leaving = second.release(); // Queues final UNLISTEN before returning.
  const replacement = notifications.subscribe('jobs_changed', subscriber);
  await Promise.all([leaving, replacement.ready]); // Replacement LISTEN follows that UNLISTEN.
  await replacement.release();
} finally {
  await notifications.stop();
  await pool.close();
}
```

Connection readiness and individual membership operations have five-second deadlines. `stop()`
invalidates the generation before aborting connecting/registering work, then closes its resources.
Connection shutdown and startup-error disposal use the driver's separate five-second cleanup
budget. A later subscription may open a replacement after old resource cleanup. For final application
shutdown, stop accepting subscriptions before calling `stop()`.

This example deliberately disables automatic reconnect. A disconnect or failed setup/membership
operation invalidates that application generation once and calls each remaining subscriber's
`onDisconnect`. In an SSE application, that handler should close its own response. A fresh browser
subscription must recheck authorization and reconcile authoritative HTTP/database state before
resuming updates: notifications missed during the gap have no replay. Adapt that policy to your
application; neither driver reconnect nor the example supplies replay or authorization.

Generation and subscriber-identity guards fence stale notifications and prevent old connection
callbacks from stopping their replacement. Application callback failures are reported separately
without interrupting other subscribers. Keep asynchronous callback errors and HTTP recovery under
application ownership.

If startup needs schema/table discovery, query through the existing application pool or a held
session before establishing subscriptions. Bound that startup work and guard late results with the
application's shutdown/generation state. Reusing that pool avoids a second short-lived connection;
the listener does not need an unrestricted query or initialization hook for application discovery.
