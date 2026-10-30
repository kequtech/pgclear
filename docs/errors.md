# Errors, timeouts, and shutdown

[Documentation](README.md) · [Configuration](configuration.md) · [Sessions](sessions.md)

Distinguish PostgreSQL errors from driver failures, and keep write outcomes in mind when deciding
whether to retry. pgclear never retries a query or transaction automatically.

## Handle errors

```ts
import { DatabaseError, DriverError } from '@kequtech/pgclear';

try {
  await pool.queryClassic('SELECT 1', undefined, { timeoutMs: 1000 });
} catch (error) {
  if (error instanceof DatabaseError) {
    console.error('PostgreSQL SQLSTATE:', error.code, error.constraint);
  } else if (error instanceof DriverError) {
    console.error('Driver failure:', error.code, error.outcome);
  }
  throw error;
}
```

`DatabaseError.code` is the server's SQLSTATE, such as `23505` for a unique constraint violation.
It also has `severity` and, when supplied by the server, `detail`, `hint`, `position`, `schema`,
`table`, `column`, `dataType`, `constraint`, and `routine`. It does not have an `outcome` property.

`DriverError.code` is one of the stable `PGCLEAR_*` codes below. Diagnostic message text can change;
branch on the code instead. Application callbacks and COPY sources may also throw their own errors.
If work and cleanup both fail, an `AggregateError` preserves both, with the work error first.

| Driver code                 | Meaning                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- |
| `PGCLEAR_CONFIGURATION`     | Invalid options, URI, codec, or registry                                         |
| `PGCLEAR_AUTHENTICATION`    | Authentication or server-proof failure                                           |
| `PGCLEAR_CONNECTION_LOST`   | Connection lost during work                                                      |
| `PGCLEAR_CLOSED`            | Closed connection/pool or work rejected during shutdown                          |
| `PGCLEAR_QUEUE_FULL`        | Connection operation queue or pool acquisition queue is full                     |
| `PGCLEAR_TIMEOUT`           | A driver deadline expired                                                        |
| `PGCLEAR_ABORTED`           | An AbortSignal cancelled work                                                    |
| `PGCLEAR_COPY_SOURCE`       | COPY input source failed; inspect `cause`                                        |
| `PGCLEAR_ENCODE`            | Invalid query input, parameter, or COPY chunk                                    |
| `PGCLEAR_DECODE`            | A result could not be decoded                                                    |
| `PGCLEAR_PROTOCOL`          | Invalid, unexpected, or oversized protocol frame                                 |
| `PGCLEAR_RESULT_LIMIT`      | Buffered result limit or unsafe command count                                    |
| `PGCLEAR_COMMIT_UNKNOWN`    | COMMIT was sent but its outcome could not be confirmed                           |
| `PGCLEAR_EXPIRED`           | A released or completed scope's handle was used                                  |
| `PGCLEAR_BUSY`              | A stream or child scope owns the session                                         |
| `PGCLEAR_SESSION_STATE`     | An operation requires an idle session, or one-off pool work leaked a transaction |
| `PGCLEAR_TRANSACTION_STATE` | Unexpected state inside a managed transaction/savepoint                          |

## Outcomes and retries

`DriverError.outcome` describes the evidence observed for an operation:

| Outcome     | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| `not-sent`  | No request bytes were written for that operation             |
| `confirmed` | A definitive command completion or server error was received |
| `unknown`   | Dispatch happened, but the final outcome was not observed    |

Confirmation does not imply that the surrounding transaction committed or that row decoding
succeeded. An error while decoding a write's returned rows can occur after PostgreSQL executed the
write. A timeout or disconnect does not prove rollback.

Losing the response to COMMIT raises `PGCLEAR_COMMIT_UNKNOWN`. A confirmed COMMIT tag establishes
success even if the connection then closes. For uncertain writes, reconcile persistent state or use
application idempotency keys before retrying. A PostgreSQL serialization failure can be retried as a
whole transaction when the application's work is safe to repeat.

## Deadlines

```ts
await pool.queryClassic('SELECT pg_sleep(10)', undefined, { timeoutMs: 100 });
// Alternatively, pass { signal: controller.signal } from an AbortController.
```

The driver accepts `signal` and `timeoutMs` on operations. A deadline starts at invocation and
includes waiting in queues, acquisition where applicable, and execution. The earliest inherited,
local, connection-startup, or acquisition deadline wins for that stage.

- `pool.withSession` and managed transaction options cover the whole scope. Savepoints inherit
  their parent's scope deadline.
- `pool.acquire` options cover acquisition only. They do not limit the lifetime of the returned lease.
- The second `connect` argument covers startup only.
- Stream deadlines include time waiting for the consumer. COPY deadlines include source/destination
  waits while the transfer remains active.
- Listener `timeoutMs` covers initial readiness; its `signal` remains active for the listener lifetime.

An omitted operation timeout adds no application deadline. Zero is an immediate deadline, including
for startup/acquisition; the two pool retirement settings use zero to disable retirement instead.
The separate cleanup budget is five seconds, so rejection and resource disposal can finish after
the application deadline. `timeoutMs` produces `PGCLEAR_TIMEOUT`; cancelling with an ordinary
AbortSignal, including `AbortSignal.timeout`, produces `PGCLEAR_ABORTED`.

Before dispatch, cancellation removes queued work. After dispatch, active cancellation retires the
connection so a late cancel cannot affect later work. It does not make that handle reconnect.
Cancelling a callback scope expires its handle, but cannot forcibly stop arbitrary JavaScript;
late database calls reject.

## Recovery

Parameter encoding errors occur before dispatch. Ordinary decoder errors drain the server response
before allowing later work on a usable session. Malformed protocol data and frame/result overflow
destroy the connection. A PostgreSQL statement error inside a transaction can leave it failed until
rollback or savepoint recovery.

Released handles never become valid again, even when their physical connection is reused. A
standalone connection must be replaced explicitly after loss; a pool can open a new connection for
subsequent operations. A listener reconnects only when configured to do so.

## Shutdown

Stop accepting application work, finish request handlers, then close owned resources:

```ts
await pool.close({ timeoutMs: 5000 });
```

Connections, pools, and listeners accept `close({ timeoutMs })`, defaulting to five seconds. Close
is idempotent; the first accepted call fixes its deadline. `timeoutMs: 0` forces immediate connection
shutdown. Close rejects new work and pool waiters, expires callback/lease handles, drains admitted
operations within the deadline, then destroys remaining transports. Active streams are closed as
part of scope cleanup.

Pool close affects only its own connections. Close standalone connections and dedicated listeners
separately. Close waits for owned client resources, not arbitrary application callbacks or proof of
remote rollback. Surface cleanup failures even when application work already failed.

## Observing operations

```ts
import { createPool } from '@kequtech/pgclear';

const pool = createPool({
  connectionString: process.env.DATABASE_URL!,
  onEvent(event) {
    if (event.type === 'operation') {
      console.log(
        event.sessionId,
        event.operation,
        event.durationMs,
        event.outcome,
        event.errorCode,
      );
    }
  },
});
```

`onEvent` receives connect/disconnect, PostgreSQL notice, and operation timing/outcome events.
Disconnect events include `expected`; operation events include the operation name, duration,
outcome, and optional error code. Operations include query, Describe, script, prepare,
statement-close, stream, copy-from, and copy-to.

Observers are not awaited. Their exceptions/rejections cannot change operation outcomes. Events
omit SQL, parameters, credentials, and cancel keys. Server notices and error diagnostics can still
contain application values, so choose what to log accordingly.
