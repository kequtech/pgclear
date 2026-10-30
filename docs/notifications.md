# Notifications

[Documentation](README.md) · [Configuration](configuration.md) · [Shutdown](errors.md#shutdown)

`listen` opens a dedicated connection, registers fixed LISTEN channels, and calls your handler for
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

| Option           | Meaning                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `channels`       | Required nonempty array of channel names; duplicates are removed |
| `onNotification` | Required handler receiving `{ channel, payload, backendPid }`    |
| `onStatus`       | Optional handler for status changes                              |
| `reconnect`      | Retry after an established connection is lost; default `false`   |
| `timeoutMs`      | Deadline for initial readiness, including registration           |
| `signal`         | Cancellation for the entire listener lifetime                    |

Channel names are quoted as SQL identifiers and checked against the server's identifier length
limit. They cannot be changed on an existing listener. Handlers are not awaited and provide no
backpressure. Exceptions and rejected promises from observers are isolated from driver outcomes;
handle asynchronous application work and its failures explicitly.

## Disconnects and delivery gaps

`listener.status` exposes the current state. Each status includes a `generation`; every successful
registration increments it. The state is one of:

- `connected`, with `session` information.
- `disconnected`, with an `error`.
- `reconnecting`, with an `attempt` number.
- `closed`, after permanent shutdown.

Reconnect is opt-in and uses exponential backoff with jitter, capped at 30 seconds. It opens a new
connection and registers the same channels. Initial connection or registration failure rejects
`listen`; it does not start background retries. Without reconnect, a lost connection closes the
listener.

Notifications missed during a disconnect are not replayed. Treat messages as signals to inspect
persistent application state when reliable processing matters. Use status/generation changes to
notice a possible gap and reconcile that state.

Use direct PostgreSQL or PgBouncer session pooling. Transaction pooling cannot preserve LISTEN
registration. `listener.close(options?)` permanently stops connections and retries; it is independent
of `pool.close()` and accepts the same shutdown timeout option.
