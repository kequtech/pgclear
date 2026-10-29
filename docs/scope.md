# Scope and release boundary

pgclear is a PostgreSQL network driver for TypeScript and JavaScript. It owns transport,
authentication, protocol scheduling, sessions, pooling, value conversion, and database diagnostics.
It accepts finished SQL and separate values, with a small value-binding template tag. Tenon owns SQL composition, schema inference, migrations,
affected-row policy, and its application-facing API.

Schema type generation belongs in pgclear as a library export (D34), sharing its conversion
knowledge and reading catalog metadata explicitly on request. Intentional query checking, SQL
composition, file output and migration coordination remain in Tenon. The driver adds no compiler
integration, runtime result schema, fragment/expansion/chooser API or implicit catalog discovery.

## Initial support

- Node.js 24+, ESM, generated declarations shipped with the package.
- PostgreSQL 16 and 18 in the integration matrix. Other versions are unverified until added.
- PostgreSQL protocol 3.0 on both server versions. Negotiating 3.2 is deferred and must not be
  accidentally advertised; protocol versions have different cancellation-key formats.
- TCP, verified TLS, Unix sockets, trust/password authentication, SCRAM-SHA-256 and channel binding
  over TLS. MD5 is a compatibility feature with an explicit test, not the preferred configuration.
- One explicit host per connection configuration. New connections can refresh a password provider.
- Direct PostgreSQL and a tested PgBouncer transaction-pooling configuration. Session features
  require a direct connection or session pooling.

No browser, Workers, Deno-specific, native libpq, Kerberos/GSS, multi-host failover, logical
replication, ORM, migration engine, or pg/Postgres.js compatibility layer is promised for 0.1.
There is no application account system or deployment service to provision.

## First release

0.1 includes ordinary queries, description without execution, explicit sessions, bounded pooling,
transactions/savepoints, exact integer/decimal defaults, named preparation with explicit disposal,
cancellable operations, bounded shutdown, row streaming, COPY streams, and dedicated notification
listeners. Pipelining is deferred outside the first release ([D33](decisions.md#d33--defer-pipelining-and-proceed-to-release-readiness)).
Queries execute sequentially per physical connection. Reconsider pipelining only for a demonstrated
consumer need that justifies its lifecycle and recovery complexity.

The Tenon integration gate is an earlier milestone, after query/description/session/pool/codec
correctness. Tenon need not wait for notification supervision or performance work to trial the core.

Initial publication is prepared as `@kequtech/pgclear@0.1.0`, with public npm access configured.
Publication is pending an explicit instruction; preparing the manifest does not publish it.
The repository remains private. Repository visibility and any future unscoped npm name are separate
decisions; current GitHub links require repository access until visibility changes.

## Success measures

1. Tenon can replace its driver boundary without reaching into transport internals.
2. A killed session cannot execute another statement, including from a still-running callback.
3. Concurrent request failures never shift result ownership or leave promises pending.
4. Codec behavior and declared runtime representations agree, including arrays containing NULL.
5. Shutdown and early stream exit release owned client resources within documented bounds.
6. A standalone application can use the same API without installing Tenon.

Performance comparisons follow correctness. Measure equivalent preparation, codecs, pool sizes,
network latency, memory use, and concurrency. Local query throughput is not a production claim.
