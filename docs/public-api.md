# API overview

[Documentation](README.md) · [First query](../README.md#install-and-run-a-query)

The package root, `@kequtech/pgclear`, exports all supported runtime functions and TypeScript types.
Internal modules are not entry points. This page is a map of the API; the linked guides contain
examples, options, and lifecycle details.

## Runtime exports

| Export                                         | Purpose                                                    |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `createPool(options)`                          | Create a lazy connection pool                              |
| `connect(options, operationOptions?)`          | Open one standalone connection                             |
| `sql`                                          | Build a query by binding each template interpolation       |
| `param(value, codec, format?)`                 | Bind a value with an explicit PostgreSQL type and encoder  |
| `json(value, type?)`                           | Bind JSON; defaults to jsonb                               |
| `defaultCodecs`                                | Immutable default result codec registry                    |
| `builtin`                                      | Built-in scalar, array, and optional representation codecs |
| `createTemporalCodecs(constructors, options?)` | Create opt-in Temporal output codecs                       |
| `listen(connectionOptions, listenerOptions)`   | Start a dedicated notification listener                    |
| `DatabaseError`, `DriverError`                 | Server diagnostics and driver failures                     |

## Connections, pools, and ownership

A pool borrows a connection for each one-off operation. Hold a session for related work, and use a
managed transaction when it must commit together. See [pools, sessions, and transactions](sessions.md).

| Capability                                    | Pool | Connection / lease / session callback | Transaction / savepoint |
| --------------------------------------------- | ---- | ------------------------------------- | ----------------------- |
| `query`, `queryClassic`, `describe`, `codecs` | Yes  | Yes                                   | Yes                     |
| `prepare`, `stream`, `copyFrom`, `copyTo`     | —    | Yes                                   | Yes                     |
| `script`                                      | —    | Yes                                   | —                       |
| `transaction`                                 | Yes  | Yes                                   | —                       |
| `savepoint`                                   | —    | —                                     | Yes                     |
| `info`, `transactionStatus`                   | —    | Yes                                   | Yes                     |

Pools additionally expose `acquire`, `withSession`, `stats`, and `close`. Standalone connections
own `close`; leases own `release`. Callback handles cannot release or close the connection they
borrow. Handles expire with their scope.

## Configuration

[Configuration](configuration.md) lists URI syntax, every connection/pool option, defaults, TLS,
authentication, byte/queue limits, and PgBouncer constraints. Configuration is passed explicitly;
pgclear does not load environment variables or `.env`.

## Query execution and results

[Queries and results](queries.md) covers the two execution forms:

- `query(sqlTagResult, options?)`
- `queryClassic(text, values?, options?)`

Both return `QueryResult<T>` with `rows`, `fields`, `command`, `commandTag`, and `rowCount`.
`describe(textOrDescription, options?)` inspects a statement without executing it.
`session.script(text, options?)` returns ordered result sets for unbound multi-statement SQL.

## Codecs and parameters

[Values and codecs](values.md) explains plain parameters, JSON, arrays, exact numbers, result
registries, and custom codecs. Input encoders and output decoders are independent.

### Date and Temporal inputs and outputs

[Dates and Temporal](values.md#dates-and-temporal) covers direct Date/Temporal inputs and explicit
Date/Temporal output codecs. Default temporal outputs remain strings.

### Default output representations

The [output mapping](values.md#default-output-types) lists PostgreSQL-to-JavaScript conversions.
Int8 and numeric results are strings, JSON uses `JSON.parse`, and unrecognized types remain text.

### Custom representations

[Custom codecs](values.md#custom-representations) and
[type metadata](values.md#type-metadata-for-downstream-tools) explain registry overrides and
TypeScript representation declarations for downstream tooling.

### Exact integers and counts

[Exact integers](values.md#exact-integers) covers string/bigint choices. SQL result values and
command counts are separate: `count(*)` is a string by default, while `rowCount` is `number | null`.

## Transactions and savepoints

[Transactions](sessions.md#transactions) commit successful callbacks and roll back failures.
[Savepoints](sessions.md#savepoints) allow partial recovery inside a transaction. Use each callback's
supplied handle and await its work. There are no automatic transaction retries.

## Prepared statements

[Prepared statements](sessions.md#prepared-statements) belong to the exact scope that creates them.
Their handle exposes `description`, `query(values?, options?)`, and `close()`.

## Row streams and COPY

[Streams and COPY](streaming.md) covers demand-driven row batches, byte input/output, backpressure,
early close, and completion results. Consume or close a stream before running other session work.

## Notifications

[Notifications](notifications.md) describes fixed channels, dedicated connections, status changes,
optional reconnect, and delivery gaps. Notifications have no replay after a disconnect.

## Schema generation migration

Version 0.3.0 removed `generateDefinitions`, `GenerateOptions`, and schema generation from pgclear.
Use [Tenon](https://github.com/kequtech/tenon-orm) for schema generation and query checking. Move those
imports to `@kequtech/tenon-orm` and follow its connection, namespace, and output options. Published
pgclear 0.2.0 retains its original API.

pgclear retains runtime codecs, Describe, and [representation metadata](values.md#type-metadata-for-downstream-tools).
Tools can inspect `executor.codecs` and select per-query result codecs on the same held session.
There is no schema-generation compatibility wrapper or runtime dependency on Tenon.

For migrations from pre-0.2 versions, replace `query(textOrStatement)` with `queryClassic(text, values)`
or `query(sqlTagResult)`. Int8 outputs now default to strings; command counts use `number | null`.
Version 0.3.0 accepts direct bigint inputs again and adds opt-in bigint output codecs. See the
[release notes](../CHANGELOG.md) for changes by version.

## Deadlines, errors, and shutdown

[Errors, timeouts, and shutdown](errors.md) documents error codes, `DriverError.outcome`, cancellation,
whole-scope deadlines, cleanup, and observation events. `DatabaseError` carries server SQLSTATE and
diagnostics. Uncertain write/COMMIT outcomes require application reconciliation before retrying.

## Compatibility

pgclear requires Node.js 24+ and ESM. JavaScript and TypeScript consumers use the same runtime API;
declarations ship in the package. CI is configured for Node 24/26 and PostgreSQL 16/18, with separate
native TLS, Unix socket, and PgBouncer fixtures. Other PostgreSQL versions are not in that matrix.
The driver does not support browser runtimes, pipelining, binary result negotiation, or automatic
catalog-driven type discovery.

The package root's exports/declarations and documented behavior form the public contract. Result
shapes, default representations, and error codes/outcomes are part of that contract; diagnostic
message wording is not a machine-readable interface.

During 0.x development, patch releases preserve compatibility within a minor release line.
Incompatible API or representation changes use a new minor version with migration notes. Published
versions are not replaced. Same-version package copies in one realm may exchange in-process
capabilities; compatibility between different releases is not promised.
