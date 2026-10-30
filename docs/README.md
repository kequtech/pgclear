# Documentation

Start with the [README](../README.md) to install pgclear and run a complete example. These guides
explain the current API; [release notes](../CHANGELOG.md) describe changes between versions.

| I want to…                                  | Read                                             |
| ------------------------------------------- | ------------------------------------------------ |
| Run SQL and understand the result           | [Queries and results](queries.md)                |
| Send JSON, arrays, dates, or exact numbers  | [Values and codecs](values.md)                   |
| Hold a connection or use a transaction      | [Pools, sessions, and transactions](sessions.md) |
| Configure a connection, TLS, or pool limits | [Configuration](configuration.md)                |
| Read many rows or transfer COPY data        | [Streams and COPY](streaming.md)                 |
| Receive LISTEN/NOTIFY messages              | [Notifications](notifications.md)                |
| Handle failures, cancellation, or shutdown  | [Errors, timeouts, and shutdown](errors.md)      |
| Find a method or check compatibility        | [API overview](public-api.md)                    |

Examples in the guides use an existing `pool`, `session`, or `connection` unless they create one.
SQL examples that reference application tables assume you have created those tables. All consumer
guides above ship in the npm package.

Contributor documentation lives in the repository:

- [Development and testing](https://github.com/kequtech/pgclear/blob/main/docs/development.md)
- [Architecture](https://github.com/kequtech/pgclear/blob/main/docs/architecture.md)
- [Benchmarks and recorded measurements](https://github.com/kequtech/pgclear/tree/main/benchmarks)
