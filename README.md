# pgclear

A standalone TypeScript PostgreSQL driver being designed around explicit session ownership,
predictable failure handling, and first-class protocol operations. Tenon is the first intended
consumer; pgclear has no runtime dependency on Tenon.

**Status: design and project setup. There is no executable database driver yet.** The package is
private to prevent accidental publication until the implementation and release gates are ready.

The canonical specifications and implementation plan live in [docs/](docs/README.md). Start with
the [public API](docs/public-api.md), [architecture](docs/architecture.md), and
[implementation plan](docs/implementation-plan.md). Accepted choices are recorded in the
[decision log](docs/decisions.md).

Node.js 24 and npm are the initial development foundations. Run `npm ci` followed by `npm run check`
to check formatting and compile the proposed API and usage examples. These checks do not establish
driver behavior. Local database setup is described in [development](docs/development.md).
