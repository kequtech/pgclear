# Tenon regression trial

This optional consumer trial runs the original Tenon pg baseline and a pgclear candidate in isolated
snapshots. It does not edit the active Tenon checkout or publish either package. Tenon keeps SQL
composition, cardinality/guarded-write policies, checking, migrations and file ownership.

## Run

With root dependencies installed, Node 24+, PostgreSQL/client tools and
`PGCLEAR_TEST_DATABASE_URL` configured in `.env` for `pgclear_test`:

```sh
npm run trial:tenon
# Or select a checkout containing the pinned commit:
npm run trial:tenon -- --source /path/to/tenon-orm
```

The default source is the sibling Tenon checkout. `trials/tenon/manifest.json` pins Tenon 0.3.1 at
`4d6cb977a4c7fa71ee836ca056bdf95986d4ab3a`. The runner reads that Git object, ignoring uncommitted
files; it does not fetch a moving branch or load Tenon's `.env`. Tests use owned schemas and
identified backend connections rather than resetting the database.

## Fixture

- `adapter.patch`: production integration using the public pgclear API.
- `regressions.patch`: complete adapted test suite and type examples.
- `contract.test.mjs`: packed-consumer workflows for both candidates.
- `run.mjs`: snapshot, build, install and validation orchestration.

The runner builds/packs pgclear, archives Tenon twice, redirects its test database to `pgclear_test`,
and runs the original pg full check. It applies both patches to the candidate, runs its full check,
then installs the two packed Tenon artifacts into separate consumers. Dependencies install with
lifecycle scripts disabled; builds and checks run explicitly. TypeScript 6/7 consumers and CLI
workflows use real package exports rather than source aliases.

Candidate expectations follow pgclear defaults: bigint counts, exact numeric strings, temporal text,
Uint8Array, explicit JSON/array parameters and `Database[table]` types. Query inspection uses the
public codec representation API; finished SQL uses `queryClassic`. No pg-compatible runtime facade
or duplicated driver cleanup is introduced.

## Results and adoption

Runs write snapshots, tarballs, hashes, step logs and `report.json` to ignored
`.trial-dist/tenon-m4-*`; `.trial-dist/latest-tenon-trial.json` points to the latest attempt.
The [0.1.0 checkpoint](release-0.1.0-validation.json) records PostgreSQL 16.15/18.0 passes for all
180 adapted tests and 20 candidate contract cases. The original 180-test pg baseline runs separately;
its additional contract fixture passes 15 cases and skips five candidate-only features.

The candidate removes duplicated conversion/generation modules, custom Describe dispatch,
transaction-loss supervision and shutdown interception. Observable tests retain rollback, isolation,
savepoint ordering, expiry, shutdown, borrowed ownership, migrations/locks, generation and checking.

Actual adoption requires reconciling the patches with current Tenon, reviewing its deliberate public
contract changes, and running application workflows on that revision. Consumer proxy deployments
need separate validation if used. A passing isolated trial does not change the active consumer.
