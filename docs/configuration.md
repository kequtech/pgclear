# Configuration

[Documentation](README.md) · [Sessions and pools](sessions.md) · [Timeouts](errors.md#deadlines)

`connect`, `createPool`, and `listen` accept a PostgreSQL URI or a connection options object. Pool
options extend connection options. Explicit object fields override URI values; `undefined` fields
do not erase URI values. Unknown options and `null` settings reject.

```ts
import { createPool } from '@kequtech/pgclear';

const pool = createPool({
  connectionString: process.env.DATABASE_URL!,
  applicationName: 'my-app',
  maxConnections: 10,
});
```

The driver does not read environment variables, `.env`, service files, or pgpass. Your application
must load and pass its configuration. `createPool` validates synchronously and connects on demand;
`connect` resolves after authentication and startup.

## Connection settings

| Option              | Default          | Meaning                                                                      |
| ------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `connectionString`  | None             | `postgres://` or `postgresql://` URI                                         |
| `host`              | `localhost`      | Hostname, IP address, or absolute Unix socket directory                      |
| `port`              | `5432`           | Server port; also selects the socket filename for a Unix directory           |
| `user`              | Current OS user  | PostgreSQL role                                                              |
| `database`          | Effective `user` | Database name                                                                |
| `password`          | None             | Password string or sync/async provider                                       |
| `tls`               | `false`          | Verified TLS settings, described below                                       |
| `applicationName`   | Unset            | PostgreSQL `application_name`                                                |
| `startupParameters` | `{}`             | Additional server settings sent at startup                                   |
| `codecs`            | `defaultCodecs`  | Immutable result decoding registry                                           |
| `onEvent`           | Unset            | [Connection, notice, and operation observer](errors.md#observing-operations) |

Password providers receive `{ host, port, user, database }` and run for each new physical connection,
including replacements opened later by a pool or listener. They return a string or promise of one.

Connection startup fixes `client_encoding=UTF8`, `DateStyle=ISO`, `IntervalStyle=iso_8601`, and
`TimeZone=UTC`. `startupParameters` can set other values, for example `{ statement_timeout: '5000' }`.
Reserved keys include user/database, replication, options, protocol, those four fixed settings,
`application_name`, and names beginning `_pq_.`. Use `applicationName` for the application name.
Later SQL `SET` commands can change temporal formatting; restore session changes before pool reuse.

## Connection URIs

```text
postgresql://user:password@localhost:5432/my_database
postgresql://user:password@db.example.com/my_database?sslmode=verify-full
postgresql:///my_database?host=%2Fvar%2Frun%2Fpostgresql&user=postgres
```

Percent-encode reserved characters in usernames, passwords, paths, and query values. Supported query
keys are `host`, `port`, `user`, `password`, `dbname`, `application_name`, and `sslmode`. Query values
override the corresponding URI components. Duplicate or unsupported keys, fragments, and multi-host
URIs reject. A URI is not a general libpq configuration string.

## TLS and authentication

`tls: {}` verifies the server certificate and hostname using system trust:

```ts
const pool = createPool({
  connectionString: process.env.DATABASE_URL!,
  tls: {
    ca: trustedCaPem,
    serverName: 'db.example.com',
    channelBinding: 'require',
  },
});
```

Here `trustedCaPem` is a PEM certificate string loaded by the application. `ca` can also be an array
of PEM strings. Optional `cert` and `key` are PEM strings for client authentication and must be
supplied together. `serverName` overrides the TLS verification name; TLS over a Unix socket requires
it. Channel binding is `'prefer'` by default, or `'require'`/`'disable'`; requiring it needs SCRAM-PLUS.

URI `sslmode=disable` disables TLS. Both `require` and `verify-full` enable certificate and hostname
verification. Other modes reject. An explicit `tls` option overrides the URI setting. There is no
unverified TLS fallback.

Trust, password, MD5, and SCRAM authentication are supported. Cleartext password authentication is
allowed only over TLS or a Unix socket. MD5 remains available for compatibility.

## Connection limits

| Option                | Default             | Meaning                                            |
| --------------------- | ------------------- | -------------------------------------------------- |
| `connectTimeoutMs`    | `5000`              | Connection, authentication, and startup deadline   |
| `maxQueuedOperations` | `1000`              | Maximum unsent operations queued on one connection |
| `maxMessageBytes`     | `67108864` (64 MiB) | Maximum incoming protocol frame length             |
| `maxResultBytes`      | `67108864` (64 MiB) | Buffered wire result bytes, including metadata     |

These byte limits do not measure JavaScript heap use. A decoded result can take more memory than
its wire representation. Frame or buffered-result overflow destroys the connection. For large
results use [row streaming](streaming.md), where the result limit applies to each batch plus
metadata. COPY has its own bounded byte handoff.

`maxQueuedOperations` and `maxResultBytes` must be positive safe integers. `maxMessageBytes` must be
an integer from 4 through 4,294,967,295. Port numbers must be integers from 1 through 65,535.

## Pool settings

| Option             | Default | Meaning                                                               |
| ------------------ | ------- | --------------------------------------------------------------------- |
| `maxConnections`   | `10`    | Physical connection limit, including connecting and retiring sessions |
| `maxWaiting`       | `1000`  | Maximum queued pool acquisitions                                      |
| `acquireTimeoutMs` | `5000`  | Acquisition deadline, including new connection startup                |
| `idleTimeoutMs`    | `30000` | Retire idle connections after this duration; `0` disables             |
| `maxLifetimeMs`    | `0`     | Retire old connections when released or before reuse; `0` disables    |

Pool limits must be positive safe integers. All millisecond settings are nonnegative safe integers.
Zero means an immediate deadline except for `idleTimeoutMs` and `maxLifetimeMs`, where it disables
retirement. Lifetime expiry does not interrupt a checked-out connection.

Per-operation `{ signal, timeoutMs }` options add deadlines for acquisition, queueing, and execution.
An omitted operation timeout adds no application deadline; connection/acquisition limits still
apply. See [deadlines and cancellation](errors.md#deadlines).

## PgBouncer

Direct PostgreSQL and PgBouncer session/transaction pooling are tested. With transaction pooling,
a pgclear session owns the proxy connection, while the PostgreSQL backend can change between
transactions. A managed transaction pins its backend for the transaction.

Use a direct or session-pooled connection for session advisory locks, explicit prepared statements,
and LISTEN. The tested proxy configuration disables named prepared-statement support
(`max_prepared_statements=0`). Ordinary unnamed queries, transactions, savepoint recovery, and
cancellation are covered in transaction-pooling tests. See the repository's
[compatibility fixture](https://github.com/kequtech/pgclear/blob/main/docs/development.md#compatibility-tests)
for the exact setup.
