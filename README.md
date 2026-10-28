# pgclear

A standalone TypeScript PostgreSQL driver built around explicit session ownership,
predictable failure handling, and first-class protocol operations. Tenon is the first intended
consumer; pgclear has no runtime dependency on Tenon.

**Status: M1 connection core implemented; not ready for production or publication.** The package
exports `connect`, `DriverError`, and `DatabaseError`, with native TypeScript declarations. Pooling,
managed transactions, custom codecs, description, streaming and notification APIs remain planned.
`private: true` prevents accidental publication until the implementation and release gates are ready.

```ts
import { connect } from '@kequtech/pgclear';

const connection = await connect({ connectionString: process.env.DATABASE_URL! });
try {
  const result = await connection.query<{ value: number }>({
    text: 'SELECT $1::integer AS value',
    values: [42],
  });
  console.log(result.rows[0]?.value);
} finally {
  await connection.close();
}
```

The connection supports TCP/Unix sockets, verified TLS, trust/password/MD5/SCRAM authentication,
SCRAM channel binding, sequential extended queries, scalar results, field metadata, and bounded
startup/close. Arrays/custom codecs arrive in M2. Active operation interruption currently destroys
the transport; protocol CancelRequest and transaction outcome handling arrive in M3. A client-side
timeout or disconnect does not establish that a write rolled back.

The canonical specifications and implementation plan live in [docs/](docs/README.md). Start with
the [public API](docs/public-api.md), [architecture](docs/architecture.md), and
[implementation plan](docs/implementation-plan.md). Accepted choices are recorded in the
[decision log](docs/decisions.md).

Node.js 24 and npm are the development foundations. `npm ci` followed by `npm run check` checks types,
formatting, packets/authentication, packed consumers, and real database workflows. Integration tests
require `PGCLEAR_TEST_DATABASE_URL` naming an explicit `_test` database; the test harness also uses
`psql` to compare Unicode authentication with libpq. Database-independent tests run with
`npm run test:unit`. See [development](docs/development.md) for setup and verification evidence.
