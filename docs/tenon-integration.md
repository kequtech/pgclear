# Tenon as the first consumer

Tenon remains a separate package and repository. Do not modify its unfinished pg migration as part
of this project setup. The integration milestone re-reads its then-current public contracts, tests,
and driver boundary. pgclear depends on neither Tenon nor pg.

## Boundary mapping

| Tenon responsibility or need       | pgclear surface                             | Integration consequence                           |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Compiled SQL with values           | `Executor.query(Statement)`                 | Adapt ambiguous values with typed codecs          |
| Single-statement runtime execution | Always-extended `query`                     | No private queryMode option                       |
| Migration scripts                  | `Session.script`                            | Hold a session explicitly                         |
| Query inspection                   | `Executor.describe`                         | Remove custom Parse/Describe dispatch             |
| Catalog and schema inference       | Ordinary queries                            | Remains owned by Tenon                            |
| Tool/advisory locks                | `Pool.acquire` or `withSession`             | One real session; explicit cleanup or discard     |
| Managed transactions               | `Session.transaction` / pool transaction    | Retain Tenon's stronger SQL/affected-row policies |
| Guarded writes                     | `Transaction.savepoint`                     | Tenon checks row count inside the child callback  |
| Raw transaction control            | Explicit lease `.query`                     | Supported when Tenon owns boundaries itself       |
| Native driver exposure             | Real pgclear pool                           | Deliberate native API break from pg/Postgres.js   |
| Listener/COPY/cursor features      | Dedicated listener / session streaming APIs | No unexported transport operations                |
| Owned versus borrowed pool         | Close only the owned instance               | No driver-specific socket interception            |
| Native errors                      | SQLSTATE or PGCLEAR code                    | Adapt error checks without message matching       |

## Value compatibility

Tenon's generation/inspection mappings must describe actual selected codec outputs, not remembered
pg defaults. int8 becomes bigint, numeric stays string, date/timestamps become strings, bytes become
Uint8Array, and rowCount becomes bigint. Generic JSON values remain unknown. Result metadata uses
`dataTypeOid`, `tableOid`, and `columnAttribute`, rather than pg's field-property names.

Choose one deliberate migration strategy at M4: update Tenon's representations to the defaults or
install a Tenon-owned immutable compatibility codec registry. Prefer the former for new contracts;
preserving already-published Tenon behavior may justify the latter. Do not silently change consumers'
values while preserving misleading generated TypeScript. No pg compatibility preset is added to the
driver itself without a demonstrated standalone need.

Tenon's SQL compiler currently accepts unknown values. Its adapter must convert JSON and PostgreSQL
arrays explicitly using its schema/query knowledge, or require a typed wrapper when SQL context
alone cannot select a JavaScript representation. It must not turn arbitrary arrays into JSON or
guess custom OIDs. Cast-based SQL remains useful for server inference, but never chooses a JS encoder
for an ambiguous object automatically.

Affected-row policies must compare bigint counts directly or perform an explicit safe conversion
at Tenon's boundary. A metadata or policy error after a write does not reverse that write; execute
guarded statements within the existing atomic transaction/savepoint policy before reporting success.

## Regression port

Port behavioral cases, not the current helper implementation. Start with:

- Array NULL versus quoted NULL, escapes, nesting, custom codecs and consistent scalar/array types.
- Description returns parameter OIDs and field origins without evaluating a side-effecting function.
- A disconnected transaction rejects late work and cannot autocommit on a replacement session.
- One lost backend leaves unrelated transactions usable; locks are released on connection death.
- Cold/concurrent acquisition, startup failure, canceled waiters and late successful connection setup.
- A failed serialization between successful concurrent requests settles the correct three promises.
- Caught savepoint failures can recover; failed savepoint cleanup prevents commit; callbacks expire.
- COMMIT returning ROLLBACK fails; loss after COMMIT dispatch preserves unknown outcome.
- A held session performs migration/catalog work under the same backend and search_path/role.
- Owned close is bounded and borrowed pools remain usable; no reconnect occurs after close.
- At the later listener milestone, notification delivery, gaps, stable close handles and pending retries.

Tenon's `test/connection-failures.test.ts`, `preparation.test.ts`, `transactions.test.ts`,
`reservation.test.ts`, `driver.test.ts`, and description/native tests provide starting evidence.
Revalidate their names and contracts against the migration state when porting. Place reusable driver
tests in pgclear; leave Tenon policy assertions in Tenon.

## Adoption gate

First run a small external fixture against a packed pgclear artifact. Then make a separately
reviewable Tenon integration change, preserving the pg version for differential testing where
representations agree. Run Tenon's full checks and packed-consumer tests against PostgreSQL 16/18.
No benchmark improvement compensates for regressed session/transaction semantics. Driver-specific
workarounds are removed only when their behavioral regression passes through the new driver.

The M4 trial is not authorization in this setup task to publish either package or edit Tenon's
ongoing work. It defines the concrete implementation work to do next.
