# Canonical design documents

Status: accepted initial design, 2026-10-28. The M3 connection/pool/transaction core is implemented locally; later APIs remain
design targets. See [development](development.md) for the implemented subset and verification.

| Document                                                              | Responsibility                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Scope](scope.md)                                                     | Product boundary, support targets, release definition        |
| [Public API](public-api.md)                                           | Observable behavior and usage                                |
| [API contract](api-contract.ts)                                       | Target signatures; shared runtime types imported             |
| [Usage contracts](api-examples.ts)                                    | Type-checked examples, including rejected API usage          |
| [Architecture](architecture.md)                                       | Internal boundaries, state machines, failure invariants      |
| [Decisions](decisions.md)                                             | Accepted decisions, alternatives, and reasons                |
| [Implementation plan](implementation-plan.md)                         | Ordered work and behavioral completion gates                 |
| [M5 handoff](m5-handoff.md)                                           | Readiness evidence and the next prepared-statement slice     |
| [Tenon integration](tenon-integration.md)                             | First-consumer requirements and migration gate               |
| [Development](development.md)                                         | Actual setup, verification, and contributor commands         |
| [Tenon trial](tenon-trial.md)                                         | Pinned consumer trial, evidence and adoption limits          |
| [Tenon migration report](references/tenon-driver-migration-report.md) | Preserved first-consumer evidence and recommendations        |
| [Tenon typed-query review](references/tenon-typed-query-review.md)    | Independent M4 review and proposed query-generation workflow |
| [Tooling exploration](references/query-tooling-exploration.md)        | Historical discussion, superseded by D25                     |

`src/index.ts` owns implemented public exports and types. The API contract owns proposed signatures
for later milestones; the public API document owns their target behavioral meaning. Architecture
explains how to satisfy that contract. Change conflicting documents together. Record a material
reversal in the decision log rather than leaving competing designs in new files. Examples express
intended usage and compile-time constraints; they are not runtime tests or evidence of implementation.

Implemented shared signatures and `connect` are imported from `src/index.ts` in the design contract
and examples. `PlannedConnection` describes the future complete session surface; the real
`Connection` exposes query, describe, script, transaction, identity/status, and close. Pool, lease and
transaction capability types also come from the real entry point; the `Planned*` types reserve only
later preparation/stream/COPY additions. Later declarations are never
published as executable exports. Packed-consumer tests exercise the actual package declarations.

## Evidence

D25 records the final driver/tooling boundary: Tenon owns generation and checking; pgclear exposes
Describe, conversions, a value-only tag and classic query execution. The
[tooling exploration](references/query-tooling-exploration.md) preserves superseded proposals, not
planned driver features.

The initial design was informed by Postgres.js 3.4.9, pg 8.23.1, and Tenon's then-in-progress return
to pg. The maintainer subsequently supplied the completed migration's
[lessons report](references/tenon-driver-migration-report.md). Its
[assessment](tenon-integration.md#lessons-from-the-completed-migration) informs the next milestones;
the report's recommendations do not silently override accepted decisions. Revalidate Tenon's current
public contracts at the integration milestone.

The later [typed-query review](references/tenon-typed-query-review.md) distinguishes independent
verification of the original M4 trial from the author's newer Unicode-fix evidence. Its proposals
inform [D22](decisions.md#d22--describe-and-decoder-contracts-support-external-type-generation) and
the [typing assessment](tenon-integration.md#typed-query-tooling); D25 supersedes their proposed upstream tooling ownership. They do not authorize M5.

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
