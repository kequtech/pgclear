# Tenon adapter trial

Status: the complete adapted Tenon suite passes 180 tests plus 20 packed contract cases on local
PostgreSQL 16.15. Final PostgreSQL 16/18 matrix validation is recorded in development.md. Nothing was
published and Tenon's active checkout was not modified.
M6's driver and deployment checks separately pass PostgreSQL 16/18 CI.

The D35 refresh passes at `.trial-dist/tenon-m4-PdEsod/report.json` on PostgreSQL 16.15. Candidate
inspection uses `defaultCodecs.typescript(oid)` instead of its own conversion tables; the shared
fixture compares bigint, array, numeric, JSON, bytea and temporal descriptions with that public API.
The original pg baseline still passes 180 tests separately, and all 20 candidate contract cases pass.
This adds evidence for the representation API, not full adapted-consumer or current PostgreSQL 18
coverage. Tenon's active checkout remains unchanged.

This trial is a consumer regression check, not pgclear's API specification or a pg compatibility
target. Preserve independently useful PostgreSQL/driver invariants, and adapt Tenon's tests and
contracts to intentional pgclear behavior. Do not recreate pg/Postgres.js quirks, private hooks or
native facades merely to make a baseline test pass. Any new driver mechanism must have its own
standalone justification; a consumer expectation alone does not supply one (D16/D20/D25).

## Reproduce

From a pgclear checkout with dependencies installed:

```sh
npm run trial:tenon
# Or point to a local Tenon checkout containing the pinned commit:
npm run trial:tenon -- --source /path/to/tenon-orm
```

The root ignored `.env` must supply `PGCLEAR_TEST_DATABASE_URL` for the existing `pgclear_test`
database. PostgreSQL 16+, its client tools and Node 24 are needed. The trial uses randomized owned
schemas and positively identified backend PIDs; it never resets or drops the database. It installs
fixture dependencies with lifecycle scripts disabled, then explicitly runs builds/tests.

The pinned source is published Tenon **0.3.1**, commit
[`4d6cb97`](https://github.com/kequtech/tenon-orm/commit/4d6cb977a4c7fa71ee836ca056bdf95986d4ab3a).
The runner reads this exact Git object from the supplied checkout, ignoring its uncommitted files.
It does not fetch a moving branch or invoke Tenon's working directory scripts in place.

The reviewable fixture consists of `trials/tenon/manifest.json`, `adapter.patch`, `regressions.patch`, `contract.test.mjs`
and `run.mjs` in the source repository. Each run creates a fresh ignored `.trial-dist/tenon-m4-*`
directory with the two snapshots, installed consumers, tarballs, per-step logs and `report.json`.
The report records source revisions, artifact SHA256 hashes, server version and check results;
`.trial-dist/latest-tenon-trial.json` points to the most recent attempt. Keep generated packages,
node_modules, database credentials and raw logs out of Git.

## Method and scope

1. Build and pack pgclear, then verify the configured database explicitly.
2. Archive Tenon twice at the pinned commit. In the baseline test snapshot, change only the exact
   test-database allowlist/expectations from `tenon_orm_test` to `pgclear_test`.
3. Run the original pg baseline's full formatting/type/build/test check, including its packed
   consumer tests. This is the reference for detecting unrelated failures.
4. Apply the adapter and regression patches only to the candidate snapshot. Its production dependency
   is the packed pgclear tarball. Run the full formatting/type/build/test check, including packed
   production consumers and TypeScript 6/7 declarations, then pack Tenon.
5. Install both Tenon tarballs into separate consumers and run the shared contract fixture. Tests
   assert actual public behavior, intentional representation differences and generated declarations
   under TypeScript 6 and 7. The candidate uses no pg dependency or unexported driver operations.

The shared fixture exercises SQL composition, mutation fragments, bigint/count metadata, exact
numeric arrays, temporal/byte values, guarded writes and cardinality rollback, complete savepoint
serialization, aborted transactions, valid/invalid/valid JSON serialization, borrowed ownership,
Describe without execution, generated types, migration scripts/history/rollback, real advisory-lock
contention, backend loss and close. Candidate-only cases cover explicit JSON/array parameters,
strict bind rejection, duplicate columns, raw JSON tokens and unknown array OIDs. Three further
candidate-only cases exercise native prepared handles, bounded streaming, COPY FROM/TO and failed
COPY savepoint recovery, plus listener termination/reconnection alongside ORM queries and rollback.

An npm registry release is unnecessary for this boundary check. npm supports installing local
package tarballs; the trial uses the real packed exports/declarations instead of source aliases or
npm link. See [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/) and
[npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/). pgclear stays private at 0.0.0; publication
remains a separate release decision after the applicable gates.

## Selected contracts

The D25 tag/classic-entrypoint changes were rerun through this trial on 2026-10-28 against
PostgreSQL 16.15: **180 baseline tests passed**, and **17 candidate contract cases passed**.
The baseline shared fixture passed 15 cases with two candidate-only skips. Local evidence is
`.trial-dist/tenon-m4-Cz6j5D/report.json`; no new PostgreSQL 18, CI or complete-adoption result is
claimed. This run required no changes to the adapter patch or pgclear compatibility behavior.

The maintainer explicitly prioritized pgclear's standalone design over preserving Tenon's existing
promises. The candidate therefore adopts:

| Surface                                       | Trial contract                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| int8 / command counts / event counts          | bigint, with null for commands lacking a count                                      |
| numeric scalars and arrays                    | exact decimal strings                                                               |
| temporal values                               | server text, preserving precision and infinity spellings                            |
| bytea                                         | Uint8Array                                                                          |
| JSON/array binds                              | explicit `json(value)` / `param(value, codec)`; raw authored text is also possible  |
| undefined, bare arrays/objects and Date binds | local encoding errors; plain null still means SQL NULL                              |
| duplicate object columns                      | decoding error; callers use aliases or native ordinal row mode                      |
| native access                                 | real pgclear Pool and Session APIs                                                  |
| close                                         | pgclear fences waiting acquisitions and drains active wire work within its deadline |
| custom codecs                                 | application-owned immutable registry; the adapter does not mutate it                |

Tenon's SQL composition still owns insert defaults and omission of undefined assignment fields.
That behavior generates SQL; it does not normalize a bound undefined value to NULL. Count checks
compare bigint directly rather than converting a completed write's metadata to a number.
Generated/inspection mappings in this trial describe the default registry. They cannot infer an
arbitrary custom JS decoder's TypeScript type.

The adapter retains a small internal catalog calling convention, but delegates wire conversion,
Describe, pool lifecycle, transaction ownership and savepoint recovery to public pgclear operations.
It preserves Tenon's serialization of complete guarded operations, so validation and savepoint cleanup
cannot interleave with a sibling write. There is no SQL parser for encoder inference, runtime catalog
discovery, input normalization, pg-shaped native facade or new upstream API.

## Evidence and remaining adoption work

D34 moves schema type generation into pgclear. The candidate's `generateDefinitions` delegates to
that library export while retaining Tenon's shared migration lock, history-table exclusion,
file writing and checking. Its three local generation modules are removed from the candidate.
The fixture compiles `Database['models']['row']` with Tenon's typed SQL under TypeScript 6/7 and
compares the delegated source with a direct pgclear generation call. The pg baseline retains its
original `Rows` API. This changes the isolated candidate; the active Tenon checkout remains intact.
This boundary passed all 20 candidate cases and TypeScript 6/7 consumers in
`.trial-dist/tenon-m4-QHPqtq/report.json`; the separate pg baseline passed its 180 tests and 15 shared
cases. The report records a dirty pgclear working tree containing the generation implementation.

On 2026-10-28 the refreshed runner packed the M6 driver checkpoint `0d31732` with the expanded
consumer fixture. The pg baseline passed **180 tests**. The fixture has **20 cases**: 15 shared and
five candidate-only. All **20 candidate cases** passed; **15 baseline cases** passed with five
skipped. Candidate source formatting/declarations and generated types under TypeScript 6/7 also
passed. Evidence: `.trial-dist/tenon-m4-6qtkCb/report.json`, driver artifact SHA256
`1251f06a2dadc9209a7c012f292aebfd0193668b9ca4de892b25ce6a90c57303`. The report records the dirty
working tree containing the fixture additions. No driver compatibility changes were required.
The machine-readable report is the authority for a particular run's observed outcome.

The performance follow-up reran the same fixture at clean runtime checkpoint `990ac77`: all
**180 pg baseline tests**, **15 shared baseline cases** (five candidate-only skips) and **20 candidate
cases** pass again, including source declarations and TypeScript 6/7 generated consumers. Evidence:
`.trial-dist/tenon-m4-kVzHLC/report.json`, packed driver SHA256
`54d113be7ec2d4e70ca038a105dd2ee384716cb6afd8ea4fe385bff286feb883`. This is the same driver artifact
as the follow-up benchmark, with no adapter or contract changes.

The independent Tenon review found two Unicode corruption bugs after the original 15-case trial
and 93 driver tests had passed. The UTF-8 decoders and array whitespace grammar are corrected in D21.
New shared cases preserve leading U+FEFF in values/column names and 20 non-ASCII characters at array
edges. Core tests also compare array decoding with server JSON and parser behavior with PostgreSQL's
own input parser. The earlier green trial did not cover these values and did not establish full
consumer correctness.

This is not a claim that Tenon's original 180 tests pass unchanged on pgclear. Its pg-native mocks,
configuration, result assertions and notification/lifecycle hooks must be replaced with tests of the
selected public contracts. The expanded fixture now covers preparation, streaming, COPY and dedicated
listeners through pgclear's actual public APIs. It does not port every historical consumer case or
recreate a pg-shaped native facade.

Before adopting the candidate in Tenon's mainline, port all applicable behavioral regressions and
public type examples, update its user documentation, run the adapted consumer suite on PostgreSQL
16/18, and review the deliberate contract changes. This consumer trial has not verified PostgreSQL
18 or proxy deployments. Separate driver CI covers PostgreSQL 16/18 TLS/Unix/PgBouncer; separate M7a
benchmarks measure driver workloads, not Tenon performance. Neither establishes consumer adoption
or a production release. The trial changes neither Tenon 0.3.1 nor pgclear's release visibility.

Tenon feedback has been received and the known Unicode blockers are fixed. D26 resumes focused M5
driver development separately from full Tenon adoption. The outstanding applicable consumer
regression/16/18 adoption gates remain open; no compatibility behavior is required merely to
reproduce pg's baseline.

## Complete regression port

The full candidate check retains 180 tests with no skips. The original pg baseline runs separately.
The adapter contains production changes; regressions.patch adapts the tests and type examples to
native pgclear contracts. No test-only pg facade or runtime conversion layer is introduced.

The port covers guarded writes and cardinality, concurrent policy/savepoint ordering, lost backends,
expired callbacks, cold pool acquisition, bounded shutdown, borrowed ownership, migrations and locks,
baseline capture/replay/security, generation and freshness, inspection, CLI behavior, fragments,
mutation expansion, copied installations and production packages without development tools.

SQL fixtures and the adapter use queryClassic for finished SQL/binds. Script fixtures hold an explicit
session. Data expectations preserve bigint counts/scalars, exact numeric arrays, temporal/interval
text, Uint8Array and explicit JSON/array parameters. Tooling uses Database[table] types and the public
codec representation API. Unknown custom decoder representations remain unknown; unrecognized text
OIDs remain strings. Listener tests preserve dedicated connection ownership.

Tenon policy unit tests now double the public driver boundary. They assert delegation and propagation
of driver failures rather than reimplement transaction cleanup or inspect sockets. Real workflows
still prove rollback, isolation, lock release, scope expiry and cancellation; pgclear's own failure
suite proves the underlying protocol and lost-COMMIT guarantees. Pool-close tests distinguish
already dispatched work from acquisition waiters and new callback statements.

The pinned baseline has 2,830 source lines; the candidate has 2,178, a reduction of 652 lines.
Removed responsibilities include conversion tables, generation modules, custom Describe dispatch,
transaction-loss supervision and shutdown interception. This line count describes the consumer
change, not overall system complexity: generation and driver guarantees remain covered in pgclear.
The active Tenon checkout stays untouched until a separate adoption change.
