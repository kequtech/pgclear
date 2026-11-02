# Reference

[Overview](../README.md) · [Queries](queries.md) · [Connections](connections.md) · [Values](values.md)

All runtime functions/types are exported from `@kequtech/pgclear`. Internal modules are not entry
points. Public declarations describe complete overloads; the tables below cover available methods,
options and stable diagnostics.

## Capabilities

| API                                                                   | Result                                           |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| createPool(options)                                                   | Lazy Pool                                        |
| connect(options, operationOptions?)                                   | Promise<Connection>                              |
| sql<Row> tag                                                          | Tagged SqlQuery<Row>, a frozen text/values tuple |
| param(value,codec,format?) / json(value,type?)                        | Explicit Parameter; JSON type defaults jsonb     |
| defaultCodecs / builtin / createTemporalCodecs(constructors,options?) | Conversion registries/codecs                     |
| listen(connectionOptions,listenerOptions)                             | Promise<Listener>                                |
| DatabaseError / DriverError / findDriverErrors(error)                 | Original errors and traversal                    |

| Capability                            | Pool | Held session/lease/connection | Transaction/savepoint |
| ------------------------------------- | ---- | ----------------------------- | --------------------- |
| query, queryClassic, describe, codecs | Yes  | Yes                           | Yes                   |
| prepare, stream, copyFrom, copyTo     | —    | Yes                           | Yes                   |
| script                                | —    | Yes                           | —                     |
| transaction                           | Yes  | Yes                           | —                     |
| savepoint                             | —    | —                             | Yes                   |
| info, transactionStatus               | —    | Yes                           | Yes                   |

Pool additionally has acquire, withSession, stats and close. Leases release; standalone connections
close; callback handles own neither. [Connections](connections.md) defines scope ownership.

## Query and operation options

| Method                              | Signature / result                                               |
| ----------------------------------- | ---------------------------------------------------------------- |
| query(tag,options?)                 | QueryResult<Row>                                                 |
| queryClassic(text,values?,options?) | QueryResult<Row>; values defaults []                             |
| describe(textOrStatement,options?)  | Description: parameterTypes, fields; no execution                |
| script(text,options?)               | Ordered QueryResult[]; no values                                 |
| prepare(textOrStatement,options?)   | PreparedStatement: description, query(values?,options?), close() |
| stream(statement,options?)          | RowStream: fields promise, async rows, completion, close()       |
| copyFrom(text,source,options?)      | CommandResult; source is AsyncIterable<Uint8Array>               |
| copyTo(text,options?)               | CopyStream: async bytes, completion, close()                     |

OperationOptions is {signal?,timeoutMs?}. Query/prepared-query options add rowMode (object default,
array for positional tuples) and codecs. Stream options additionally accept batchSize, default 100,
range 1–2147483647. A stream statement can be tagged SQL, text, [text,values] or
{text,values?,parameterTypes?}; prepare/Describe accept text or {text,parameterTypes?}.
Scripts/COPY accept no bound values. Scripts/Describe/COPY accept no codec override.

QueryResult has readonly rows/fields plus command, commandTag and rowCount:number|null. Fields
contain name, dataTypeOid, tableOid, columnAttribute, dataTypeSize, typeModifier and format.
StreamCompletion is {status:'complete',result:CommandResult} or {status:'closed'}.

TransactionOptions adds isolation (read committed/repeatable read/serializable), readOnly and
deferrable to OperationOptions; omission uses server defaults. Deferrable true requires serializable
and readOnly true. Savepoints inherit options with no separate argument. acquire/connect options
bound acquisition/startup only. CloseOptions has timeoutMs, default 5000; zero is immediate. Lease
release accepts {discard?:boolean}. Scope and cancellation semantics are in [errors](errors.md).

## Connection options

| Option              | Default          | Meaning                                                             |
| ------------------- | ---------------- | ------------------------------------------------------------------- |
| `connectionString`  | None             | `postgres://` or `postgresql://` URI                                |
| `host`              | `localhost`      | Hostname, IP address, or absolute Unix socket directory             |
| `port`              | `5432`           | Server port; also selects the socket filename for a Unix directory  |
| `user`              | Current OS user  | PostgreSQL role                                                     |
| `database`          | Effective `user` | Database name                                                       |
| `password`          | None             | Password string or sync/async provider                              |
| `tls`               | `false`          | Verified TLS settings, described below                              |
| `applicationName`   | Unset            | PostgreSQL `application_name`                                       |
| `startupParameters` | `{}`             | Additional server settings sent at startup                          |
| `codecs`            | `defaultCodecs`  | Immutable result decoding registry                                  |
| `onEvent`           | Unset            | [Connection, notice, and operation observer](errors.md#observation) |

Password providers receive host/port/user/database. TLS accepts false or {ca?,cert?,key?,serverName?,
channelBinding?}. ca is PEM text or a list; cert/key must be paired; channelBinding defaults prefer,
with require/disable alternatives. [Connection setup](connections.md) owns URI/authentication rules.

| Option                | Default             | Meaning                                            |
| --------------------- | ------------------- | -------------------------------------------------- |
| `connectTimeoutMs`    | `5000`              | Connection, authentication, and startup deadline   |
| `maxQueuedOperations` | `1000`              | Maximum unsent operations queued on one connection |
| `maxMessageBytes`     | `67108864` (64 MiB) | Maximum incoming protocol frame length             |
| `maxResultBytes`      | `67108864` (64 MiB) | Buffered wire result bytes, including metadata     |

maxQueuedOperations/maxResultBytes are positive safe integers. maxMessageBytes is 4–4294967295;
port is 1–65535. Byte limits measure wire allocations, not decoded heap use. Stream result budgets
apply per batch plus metadata. Overflow retires the connection.

## Pool options

| Option             | Default | Meaning                                                               |
| ------------------ | ------- | --------------------------------------------------------------------- |
| `maxConnections`   | `10`    | Physical connection limit, including connecting and retiring sessions |
| `maxWaiting`       | `1000`  | Maximum queued pool acquisitions                                      |
| `acquireTimeoutMs` | `5000`  | Acquisition deadline, including new connection startup                |
| `idleTimeoutMs`    | `30000` | Retire idle connections after this duration; `0` disables             |
| `maxLifetimeMs`    | `0`     | Retire old connections when released or before reuse; `0` disables    |

Pool counts are positive safe integers; milliseconds are nonnegative safe integers. Zero means an
immediate deadline except idleTimeoutMs/maxLifetimeMs, where it disables retirement. Lifetime expiry
does not interrupt checked-out work. stats contains total/idle/leased/waiting, including connecting
and retiring sessions in total.

## Listeners

listen's first argument uses ConnectionOptions, not PoolOptions. ListenerOptions requires channels
(possibly empty) and onNotification({channel,payload,backendPid}). Optional onStatus observes
connected/disconnected/reconnecting/closed statuses with generation. reconnect defaults false.
timeoutMs covers initial readiness; signal covers lifetime. subscribe(channel,options?) and
unsubscribe(channel,options?) await acknowledgement with per-change operation options. close uses
CloseOptions. Membership, reconnect and gap semantics are in [notifications](notifications.md).

## Error codes

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

DriverError has code, outcome and optional column/dataTypeOid. DatabaseError has PostgreSQL SQLSTATE,
severity and optional server diagnostics. Outcome not-sent/confirmed/unknown concerns one operation,
not a blanket transaction result. findDriverErrors returns readonly original DriverErrors through
causes/aggregates without wrapping, evaluating getters or duplicating shared nodes.
[Errors](errors.md) defines reconciliation, deadlines, recovery and observation semantics.

## Compatibility

Node.js 24+, ESM; tested with PostgreSQL 16/18 and Node 24/26. Browser runtimes, pipelining, binary
result negotiation and automatic catalog type discovery are outside the API. Public exports/types,
result shapes, default representations and error codes/outcomes are contracts; message wording is
not. Compatible package copies can exchange in-process capabilities in one realm; cross-release
interoperability is not promised.

During 0.x, patches preserve a minor line's API/representations; incompatible changes use a new
minor with migration notes. Published versions are immutable. Version 0.3.0 moved schema generation
to Tenon; pgclear retains Describe and codec metadata. Version 0.2.0 separated query(tag) from
queryClassic(text,values) and made int8 outputs strings. Version 0.3.3 requires
CodecRegistry.isDefaultDecoder on typed adapters/test doubles; real registries still use
defaultCodecs/with(). See [changelog](../CHANGELOG.md) for complete upgrade actions.
