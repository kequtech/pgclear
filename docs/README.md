# Canonical design documents

Status: accepted initial design, 2026-10-28. The M1 connection core is implemented; later APIs remain
design targets. See [development](development.md) for the implemented subset and verification.

| Document                                      | Responsibility                                          |
| --------------------------------------------- | ------------------------------------------------------- |
| [Scope](scope.md)                             | Product boundary, support targets, release definition   |
| [Public API](public-api.md)                   | Observable behavior and usage                           |
| [API contract](api-contract.ts)               | Target signatures; shared runtime types imported        |
| [Usage contracts](api-examples.ts)            | Type-checked examples, including rejected API usage     |
| [Architecture](architecture.md)               | Internal boundaries, state machines, failure invariants |
| [Decisions](decisions.md)                     | Accepted decisions, alternatives, and reasons           |
| [Implementation plan](implementation-plan.md) | Ordered work and behavioral completion gates            |
| [Tenon integration](tenon-integration.md)     | First-consumer requirements and migration gate          |
| [Development](development.md)                 | Actual setup, verification, and contributor commands    |

`src/index.ts` owns implemented public exports and types. The API contract owns proposed signatures
for later milestones; the public API document owns their target behavioral meaning. Architecture
explains how to satisfy that contract. Change conflicting documents together. Record a material
reversal in the decision log rather than leaving competing designs in new files. Examples express
intended usage and compile-time constraints; they are not runtime tests or evidence of implementation.

Implemented shared signatures and `connect` are imported from `src/index.ts` in the design contract
and examples. `PlannedConnection` describes the future complete session surface; the real
`Connection` currently exposes query, identity/status, and close. Later declarations are never
published as executable exports. Packed-consumer tests exercise the actual package declarations.

## Evidence

The initial design was informed by Postgres.js 3.4.9, pg 8.23.1, and Tenon's in-progress return to pg.
Tenon's local migration is unfinished, so its current source is evidence of requirements rather than
a stable integration target. Revalidate that source at the integration milestone.

- [PostgreSQL protocol message flow](https://www.postgresql.org/docs/18/protocol-flow.html)
- [PostgreSQL message formats](https://www.postgresql.org/docs/18/protocol-message-formats.html)
- [pg client](https://github.com/brianc/node-postgres/blob/master/packages/pg/lib/client.js)
- [pg protocol parser](https://github.com/brianc/node-postgres/blob/master/packages/pg-protocol/src/parser.ts)
- [Current pg pipelining](https://node-postgres.com/features/pipelining)
- [Postgres.js connection](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js)
- [Tenon](https://github.com/kequtech/tenon-orm), especially its considerations and driver regressions
- [PgBouncer feature compatibility](https://www.pgbouncer.org/features.html)

Upstream links on `master` describe inspected implementations and can change. The protocol
specification is authoritative; neither another driver's behavior nor an upstream issue alone is
proof of correctness. No performance advantage has been measured.
