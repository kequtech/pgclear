# Tenon as the first consumer

Tenon remains a separate package and repository. Its return to pg is complete, and its maintainer
supplied the [migration lessons report](references/tenon-driver-migration-report.md). The integration
milestone re-reads its then-current public contracts, tests, and driver boundary. Changes here do not
authorize edits to Tenon. pgclear depends on neither Tenon nor pg.

## Lessons from the completed migration

The report supports the existing milestone order: a sequential connection core, codecs/Describe,
owned pooling and cancellation, then broader features and optional optimizations. It adds concrete
acceptance cases and identifies a gap in the planned JSON input API; M1 does not need to be rebuilt.

| Finding                                                                                   | Consequence for pgclear                                                                                               |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| SQL NULL and JSON null need different encodings                                           | M2 adds `json(value)`, including primitives and null; `param(null, codec)` remains typed SQL NULL                     |
| pg numeric arrays rounded `9007199254740993.25`                                           | M2 must preserve that exact text and resolve built-in array element decoders through the scalar registry              |
| Parsed JSON loses precision for large numeric tokens                                      | M2 offers explicit json/jsonb text codecs alongside the parsed defaults                                               |
| Tenon's Describe promise settled while a pg timeout timer remained live                   | M2 Describe uses the ordinary operation settlement path and child-process exit tests for success and failure          |
| A local encoding failure during named reuse could invalidate a later request with `26000` | M5 distinguishes submitted from confirmed preparation state; an encoding error cannot close or evict a good statement |
| Acquisitions can remain authenticating after their caller expires                         | M3 owns attempts before checkout and tests close/abort with late credential and authentication results                |
| One cleanup failure can prevent cleanup of other resources                                | M3 shutdown attempts all disposal paths before reporting failures                                                     |
| Bugs occur across feature combinations                                                    | M3/M5/M7 add repeatable seeded operation sequences and explicit preparation/pipeline interaction coverage             |

Some recommendations target pg compatibility, which pgclear does not promise. Keep native bigint for
int8 and bigint row counts; both preserve exact values. Keep rejecting undefined binds and ambiguous
bare arrays/objects rather than carrying over a previous driver's behavior without an explicit policy.
These choices require a small, deliberate Tenon adapter. Preserve Tenon's existing undefined-to-NULL
behavior there, and choose JSON versus PostgreSQL-array encoding explicitly when the value is ambiguous.

Nested JS arrays retain values but discard PostgreSQL lower bounds. Continue documenting that limit
and offer text/custom codecs for callers needing bounds; do not introduce a public array wrapper
merely to imply complete losslessness. The report's suggested quarantine after cancellation does not
weaken pgclear's conservative initial rule: retire every actively canceled connection.

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

The completed pg transition also accepts undefined binds as SQL NULL. The adapter must normalize
that deliberate Tenon contract rather than letting pgclear's strict bind policy become a new ORM
restriction. Do not add a global compatibility flag or extra connection configuration form.

Affected-row policies must compare bigint counts directly or perform an explicit safe conversion
at Tenon's boundary. A metadata or policy error after a write does not reverse that write; execute
guarded statements within the existing atomic transaction/savepoint policy before reporting success.

## Regression port

Port behavioral cases, not the current helper implementation. Start with:

- Array NULL versus quoted NULL, escapes, nesting, custom codecs and consistent scalar/array types,
  including exact `9007199254740993.25` numeric scalars/arrays and a scalar-codec override affecting
  its built-in array type. An explicit array codec still takes precedence.
- SQL NULL versus JSON null, JSON primitive/array inputs, raw JSON text, and Tenon's undefined binds.
- Description returns parameter OIDs and field origins without evaluating a side-effecting function.
- Description completion releases timers/listeners on success, server error, timeout and abort;
  verify child-process exit as well as promise settlement.
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

The M4 trial is not authorization to publish either package or edit Tenon's ongoing work as part
of this report assessment. It defines the later consumer integration work.
