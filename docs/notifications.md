# Notifications

[Overview](../README.md) · [Connections](connections.md) · [Reference](reference.md#listeners)

`listen` owns a dedicated connection; it does not borrow a query-pool session.

```ts
import { listen } from '@kequtech/pgclear';

const listener = await listen(process.env.DATABASE_URL!, {
  channels: ['jobs_changed'],
  reconnect: true,
  onNotification: ({ channel, payload }) => console.log(channel, payload),
  onStatus: (status) => console.log(status.state, status.generation),
});
// On application shutdown:
await listener.close();
```

Readiness resolves after initial connection and LISTEN acknowledgement, including empty membership.
Send NOTIFY/pg_notify over a separate query scope; transaction notifications deliver on commit.
Channel names are quoted identifiers and validated against the server's length limit. Callbacks are
not awaited and provide no backpressure. Observer failures are isolated; own asynchronous work and
its failures explicitly.

## Change membership

```ts
await listener.subscribe('jobs_changed', { timeoutMs: 5000 });
await listener.unsubscribe('jobs_changed');
```

Each operation accepts one channel and resolves after server acknowledgement. Duplicate subscribe
or absent unsubscribe succeeds. Membership is a set, not a reference count. Calls execute in
invocation order. An empty set keeps the connection open. Changes do not increment generation or
emit connected status. Notifications may arrive before subscribe resolves and until unsubscribe
resolves; already-started application callbacks can outlive removal.

signal/timeoutMs cover queueing, reconnect waits and acknowledgement. Queued cancellation leaves
membership unchanged. Cancellation after dispatch retires the connection; only acknowledged
membership is restored on reconnect. Without reconnect, retirement closes the listener. Close rejects
pending/new changes as PGCLEAR_CLOSED and disposes registration without waiting for acknowledgement.

## Reconnect and recover gaps

Status has generation and one of connected (session), disconnected (error), reconnecting (attempt)
or closed. Each successful connection/registration increments generation. Optional reconnect uses
exponential backoff/jitter capped at 30 seconds. It restores acknowledged membership before queued
changes. Transport loss during a change keeps it queued unless cancelled, expired or closed;
a validation/server error on a usable connection rejects only that change. Initial startup failure
rejects listen rather than starting background retries.

Notifications missed during gaps are not replayed. Use generation/status to trigger authoritative
application-state reconciliation. Use direct PostgreSQL or session pooling; transaction pooling
cannot preserve LISTEN. Listener close stops reconnect attempts independently of pool close.

## Share a listener in application code

[SharedListener](../examples/shared-listener.ts) is a complete optional example with shared readiness,
subscriber reference counts, ordered last-unsubscribe/replacement, generation fences and cancellation.
It is not a driver API. Copy/compile it in the application and adapt its recovery policy.

Keep ConnectionOptions separate from pool-only limits. Passing PoolOptions to listen does not remove
extra runtime fields; unknown options reject. SharedListener deliberately disables automatic reconnect:
a failed generation notifies subscribers, who decide how to reauthorize and reconcile before replacing
it. ready and release handles preserve subscriber identity; stop invalidates the generation before
cleanup. It uses bounded startup/membership/cleanup and reports application callback failures separately.

Authorization, subscriber routing and response lifecycle remain application responsibilities. If startup
needs table/schema discovery, query through an existing pool/session first; keep that work bounded and
fence late results with application shutdown state. The listener needs no unrestricted query hook.
