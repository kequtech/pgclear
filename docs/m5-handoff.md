# M5 handoff — explicit prepared statements first

Prepared on 2026-10-28. The completed query API and discussion outcomes are committed as `c51ea8c`.
No M5 runtime implementation has started. This is the starting brief for a fresh chat focused on M5a.

## Final scope

[D25](decisions.md#d25--driver-only-value-bound-tags-and-classic-query-execution) is authoritative.
pgclear owns protocol, conversion, metadata and session lifetimes. Tenon owns type generation,
checking, SQL fragments, expansion and other composition. No compiler integration or fragment
typing language belongs in this implementation. The implemented authoring forms are:

```ts
await db.query(sql<MyRow>`SELECT ... WHERE id = ${id}`);
await db.queryClassic<MyRow>('SELECT ... WHERE id = $1', [id]);
```

The value-only tag returns a frozen `[text, values]` tuple. Existing text/tuple/statement-object
inputs remain supported. Types are caller assertions; unannotated results stay unknown. `NoInfer`
prevents assignment context from supplying an assertion absent from the tag. Both entrypoints
share the encoder and operation lifecycle across all executor scopes.

Keep native bigint/counts, exact numeric/temporal strings, Uint8Array, strict binds and explicit
JSON/array parameters. Do not add pg/Postgres.js compatibility facades to satisfy Tenon's trial.
Its active checkout is separate and must not be modified merely to implement this milestone.

## Evidence and readiness

- Unicode fixes: `e742fbf` preserves leading U+FEFF and PostgreSQL's ASCII array-syntax whitespace.
  These are regressions, not open defects.
- Both PostgreSQL 16/18 jobs passed `npm run check` for that exact commit in
  [run 40642777907](https://github.com/kequtech/pgclear/actions/runs/40642777907). This was read after
  completion, without waiting for a new run.
- The later query API passed 106 local tests: 56 database-independent and 50 integration on
  PostgreSQL 16.15. Packed consumers verify object/array row inference and negative type cases.
- The pinned Tenon 0.3.1 trial passed 180 original pg baseline tests and 17 candidate contract cases.
  These are different suites. Evidence: `.trial-dist/tenon-m4-Cz6j5D/report.json`.
- The query API checkpoint's own PostgreSQL 18 result remains unverified. Earlier green CI does not
  verify later code. No full Tenon adoption, production deployment or performance result is claimed.

D26 permits focused driver development after the correctness follow-up. Full Tenon replacement
remains an adoption gate, not a prerequisite for implementing driver features it may itself need.

## Next slice: M5a

Implement explicit named preparation before portals/streaming (M5b) and COPY (M5c). First reconcile
[the planned signatures](api-contract.ts) with
[preparation ownership](public-api.md#description-and-preparation): the planned session exposes
`prepare`, but the planned transaction does not. Decide and document preparation/use inside
transaction and savepoint scopes before implementation; never bypass scope ownership to make a
prepared handle usable or let it survive owner expiry.

Implement the smallest complete lifecycle:

1. Allocate driver-generated names on an explicitly owned scope. Return parameter/field description;
   do not add an automatic cache or execution retries.
2. Separate submitted creation from confirmed preparation. A handle is usable only after creation,
   description and ReadyForQuery. Preserve FIFO reservation before user encoders run.
3. Execute through the ordinary scheduler, codecs, options, cancellation and result path. A local
   bind-encoding failure leaves a confirmed server statement intact.
4. Close idempotently after accepted executions, reject later work and dispose names before scope
   reuse. Handles expire with their owner; lost connections cannot resurrect either.
5. Surface server invalidation/schema-change errors without automatic execution retries.

Acceptance includes valid/invalid-encoding/valid reuse without SQLSTATE `26000`, query/close FIFO,
explicit close and owner expiry, create failure/loss, disconnect/cancellation, array row mode, codec
isolation, deadlines and cleanup. Use fake servers for protocol boundaries and real PostgreSQL for
observable behavior. Add packed-consumer export/type coverage. Do not bundle streaming, COPY,
publication or a complete Tenon migration into M5a.

## Code and checks

- `src/connection/index.ts`: physical queue, response state machine and settlement.
- `src/connection/query.ts`: frontend encoding and unnamed query/Describe paths.
- `src/session/index.ts`: leases, expiring scopes, transaction/savepoint ownership and cleanup.
- `src/pool/index.ts`: capacity, acquisition and bounded shutdown.
- `src/types.ts`, `src/index.ts`: implemented API and exports.
- `docs/api-contract.ts`, `docs/api-examples.ts`: targets and compile-checked examples.
- `test/helpers/server.ts`, lifecycle tests: deterministic protocol fixtures.
- `test/helpers/database.ts`, `test/integration/`: owned real-database workflows.

Run `npm run check` using the existing `pgclear_test` and ignored `.env`. Never expose credentials.
Preserve local PostgreSQL 16; do not install 18 over it. `.github/workflows/check.yml` supplies
isolated PostgreSQL 16/18 CI services. Keep the user's preference not to wait for new CI: record
pending results rather than claiming success. The optional Tenon trial must not dictate the driver
API. Keep `private: true`; no publication is authorized.
