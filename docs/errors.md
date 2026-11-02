# Errors, cancellation and shutdown

[Overview](../README.md) · [Connections](connections.md) · [Error codes](reference.md#error-codes)

## Inspect errors

DatabaseError carries PostgreSQL SQLSTATE plus severity and optional detail, hint, position, schema,
table, column, dataType, constraint and routine. DriverError carries a stable PGCLEAR_* code and
operation outcome. Application callbacks may throw any value. Message text is diagnostic; branch
on codes and structured fields. Neither queries nor transactions retry automatically.

```ts
import { findDriverErrors } from '@kequtech/pgclear';

try {
  await persist(); // Application operation.
} catch (error) {
  const uncertain = findDriverErrors(error).some((e) => e.code === 'PGCLEAR_COMMIT_UNKNOWN');
  if (uncertain) await reconcile(); // Application policy using authoritative storage.
  throw error;
}
```

findDriverErrors returns original DriverErrors in root, cause, aggregate-member order, once each.
It follows own data properties, skips getters and handles cycles/shared nodes and non-Error causes.
It neither wraps nor logs errors. Work plus cleanup failures preserve both in an AggregateError,
with the work error first. Decode failures may identify column/dataTypeOid without SQL or values;
application-defined causes can still contain private data.

## Operation outcomes

| Outcome   | Evidence                                    |
| --------- | ------------------------------------------- |
| not-sent  | No request bytes written for that operation |
| confirmed | Definitive completion/server error received |
| unknown   | Dispatched, final outcome not observed      |

Confirmation does not establish that a surrounding transaction committed or row decoding succeeded.
A decoding error can follow an executed write. Timeout/disconnect alone proves no rollback.
PGCLEAR_COMMIT_UNKNOWN means COMMIT was sent without a confirmed outcome. An acknowledged COMMIT
is successful even if the connection subsequently closes. An empty error-tree result proves neither
commit nor rollback. Reconcile/idempotently identify uncertain effects before retrying or compensating.

## Deadlines and cancellation

Operations accept signal and timeoutMs. Deadlines start at invocation, covering queueing, acquisition
where applicable, and execution. The earliest inherited/local/connection/acquisition limit wins.

- withSession/transaction options cover the entire scope; savepoints inherit the parent deadline.
- acquire/connect operation options cover acquisition/startup only.
- Stream/COPY deadlines include consumer/source waits while transfer is active.
- Listener timeoutMs covers initial readiness; its signal covers the listener lifetime.

Omitted operation timeouts add no application deadline. Zero is immediate except pool retirement
settings, where zero disables retirement. timeoutMs produces PGCLEAR_TIMEOUT; AbortSignals,
including AbortSignal.timeout, produce PGCLEAR_ABORTED. A separate five-second cleanup budget can
extend rejection/disposal beyond the requested application deadline.

Before dispatch, abort removes queued work. Active cancellation retires the connection so late cancel
cannot hit its next user. Scope handles expire, but arbitrary JavaScript can keep running; later calls
through those handles reject. No cancelled/lost scope resumes on a new backend.
A savepoint does not isolate active cancellation: retiring the physical connection also expires
its enclosing transaction. Handle cancellation at that transaction boundary.

Encoding failures happen before dispatch. Decoder failures drain responses before safe reuse.
Malformed protocol and frame/result overflow destroy the connection. Server errors can abort a
transaction until rollback/savepoint recovery. Preserve cleanup failures even if the work already failed.

## Shutdown

Stop new work and await application handlers before closing owned resources:

```ts
await pool.close({ timeoutMs: 5000 });
```

Pools, standalone connections and listeners default to five seconds. Close is idempotent; the first
accepted call fixes the deadline. Zero forces immediate shutdown. Close rejects new work/waiters,
expires handles, drains admitted operations within its budget and destroys remaining transports.
It waits for owned driver resources, not arbitrary callbacks or proof of remote rollback. Pool close
leaves independent connections/listeners alone; close those separately.

## Observation

Connection options accept onEvent. Connect/disconnect events carry session information; disconnect
includes expected. Notices carry server diagnostics. Operation events carry sessionId, operation,
durationMs, outcome and optional errorCode. Operations cover query, describe, script, prepare,
statement-close, stream, copy-from and copy-to.

Observers are not awaited. Exceptions/rejections cannot change driver outcomes. Events omit SQL,
parameters, credentials and cancel keys. Server notices and application errors may contain values;
choose logged fields explicitly. Observation is not durable recovery state.
