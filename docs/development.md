# Development and setup

## Current project state

The repository is `git@github.com:kequtech/pgclear.git`, private, with `main` as the intended default
branch. The package is `@kequtech/pgclear`, unpublished and protected by `private: true`. The stable
Kequtech source identity is `pgclear`. Node.js 24+, npm, TypeScript and Prettier are the only initial
tooling dependencies. There are no runtime dependencies or database driver implementation yet.

```sh
npm ci
npm run check
```

The current check runs formatting and strict type checks against proposed public signatures and
usage contracts. It does not connect to PostgreSQL or claim runtime coverage. `npm run format` applies
formatting. Runtime build/test/package commands are added at M1 when real implementation exists.

## Test database

The user supplied the existing local **pgclear_test** database and the existing `postgres` role.
Connection was verified on 2026-10-28: database `pgclear_test`, role `postgres`, PostgreSQL 16.15.
No database, role or test data was created, reset or dropped during onboarding.

Use `PGCLEAR_TEST_DATABASE_URL` in the ignored `.env`; `.env.example` contains placeholders. Local
credentials follow the existing PostgreSQL convention. Never commit `.env`. Future test scripts load
that file explicitly with Node's `--env-file-if-exists=.env`; the driver does not load it. CI supplies
the same named variable directly and uses an isolated `pgclear_test` service database.

Only test persistence is needed for this library, so onboarding does not create a redundant app or
development database. If later examples need separate persistent development data, configure a
distinct database before using it. The runtime integration harness must refuse non-test databases,
use randomized owned schemas, and limit cleanup/backend termination to resources it positively owns.

## GitHub checks and documentation

The `Check` workflow runs `npm ci` and `npm run check` on pushes to main and pull requests. It has no
PostgreSQL service until runtime integration tests exist. M3 adds the PostgreSQL 16/18 matrix.

The documentation workflow uses the canonical shared Kequtech action on docs changes pushed to main.
It reads `SITE_EDITORIAL_INGEST_TOKEN` from GitHub Actions secrets and `kequtech.source` from the
manifest. The ingest credential belongs in process configuration and Actions secrets, never this
repository or workflow text. Setup verifies secret metadata; successful ingestion must be observed
from a real workflow run and is not implied by the file or secret merely existing.

The repository Actions secret was configured from the existing process credential during onboarding;
its name was verified without reading its value back. Organization-secret metadata was unavailable
with the current GitHub permissions; no organization policy was changed.

GitHub organization-secret metadata may require permissions beyond repository access. Preserve any
existing repository credential, check organization applicability where permitted, and do not widen
organization secret access as a side effect of setup.

## Working on the implementation

Read [the API](public-api.md), [architecture](architecture.md), and the next incomplete milestone in
[the plan](implementation-plan.md). Changes to accepted public behavior update the contract and
decision log together. Keep the project single-package and avoid scaffolding unsupported runtimes,
application authentication, deployments, or an ORM. Add tests for observable protocol/workflow
behavior when the corresponding implementation is introduced, not tests that inspect docs wording.
