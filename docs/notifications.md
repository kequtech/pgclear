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
Initial connection or registration failure rejects `listen`; it does not start background retries. Without reconnect, a lost connection closes the
listener.

Notifications missed during a disconnect are not replayed. Treat messages as signals to inspect
persistent application state when reliable processing matters. Use status/generation changes to
notice a possible gap and reconcile that state.

Use direct PostgreSQL or PgBouncer session pooling. Transaction pooling cannot preserve LISTEN
registration. `listener.close(options?)` permanently stops connections and retries; it is independent
of `pool.close()` and accepts the same shutdown timeout option.
