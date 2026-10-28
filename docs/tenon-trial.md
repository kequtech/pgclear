# Tenon adapter trial

Status: local consumer trial; the full Tenon adoption gate remains open. Nothing was published and
Tenon's active checkout was not modified. M3 was pushed as `a91a83b`; CI was not polled or awaited.

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

The reviewable fixture consists of `trials/tenon/manifest.json`, `adapter.patch`, `contract.test.mjs`
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
4. Apply the adapter patch only to the candidate snapshot. Its production dependency is the packed
   pgclear tarball. Check source formatting and strict declarations, then build and pack Tenon.
5. Install both Tenon tarballs into separate consumers and run the shared contract fixture. Tests
   assert actual public behavior, intentional representation differences and generated declarations
   under TypeScript 6 and 7. The candidate uses no pg dependency or unexported driver operations.

The shared fixture exercises SQL composition, mutation fragments, bigint/count metadata, exact
numeric arrays, temporal/byte values, guarded writes and cardinality rollback, complete savepoint
serialization, aborted transactions, valid/invalid/valid JSON serialization, borrowed ownership,
Describe without execution, generated types, migration scripts/history/rollback, real advisory-lock
contention, backend loss and close. Candidate-only cases cover explicit JSON/array parameters,
strict bind rejection, duplicate columns, raw JSON tokens and unknown array OIDs.

An npm registry release is unnecessary for this boundary check. npm supports installing local
package tarballs; the trial uses the real packed exports/declarations instead of source aliases or
npm link. See [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/) and
[npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/). pgclear stays private at 0.0.0; publication
remains a separate release decision after the applicable gates.

## Selected contracts

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

On 2026-10-28 the post-review runner passed on PostgreSQL 16.15: the pg baseline passed **180 tests**.
The external fixture now has **17 cases**: 15 shared cases plus two candidate-only cases. All
**17 candidate cases** passed; **15 baseline cases** passed with two skipped. Candidate source
formatting/declarations and generated types under TypeScript 6/7 also passed. The pgclear regression
suite passed **100 tests** (53 database-independent, 47 integration). The machine-readable report is
the authority for a particular run's observed outcome.

The independent Tenon review found two Unicode corruption bugs after the original 15-case trial
and 93 driver tests had passed. The UTF-8 decoders and array whitespace grammar are corrected in D21.
New shared cases preserve leading U+FEFF in values/column names and 20 non-ASCII characters at array
edges. Core tests also compare array decoding with server JSON and parser behavior with PostgreSQL's
own input parser. The earlier green trial did not cover these values and did not establish full
consumer correctness.

This is not a claim that Tenon's original 180 tests pass unchanged on pgclear. Its pg-native mocks,
configuration, result assertions and notification/lifecycle hooks must be replaced with tests of the
selected public contracts. LISTEN/native notification cases belong to M6; preparation, streaming and
COPY remain later driver work. No legacy API is recreated to make those tests pass.

Before adopting the candidate in Tenon's mainline, port all applicable behavioral regressions and
public type examples, update its user documentation, run the adapted consumer suite on PostgreSQL
16/18, and review the deliberate contract changes. This trial has not verified PostgreSQL 18, proxy
deployments, performance or a production release. It changes neither Tenon 0.3.1 nor pgclear's release
visibility, and does not advance to M5 automatically.

Tenon feedback has been received. M5 remains on hold for this correctness follow-up and the
outstanding applicable M4 adoption/16/18 gates, following the maintainer's request on 2026-10-28.
