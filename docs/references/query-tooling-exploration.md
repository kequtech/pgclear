# Intentional TypeScript query checking

Status: historical exploration, superseded by the maintainer's final decision D25 on 2026-10-28.
pgclear will not own type generation, query checking, SQL fragments, expansion or finite-choice
helpers. These are Tenon responsibilities. The text below preserves the design discussion rather
than an implementation plan. Commands and composition APIs shown here do not exist in pgclear.
The accepted value-only tag and classic query entrypoint are documented in [the public API](../public-api.md).

## Purpose and boundary

Let an engineer or coding agent write ordinary TypeScript input/result types and SQL, run a focused
check against the intended database, and continue. Treat those types as caller assertions during
normal execution. Do not require separately authored runtime schemas, a query registry, generated
wrappers or a SQL builder. A database schema model can supply types such as
`Pick<Database['user'], 'id' | 'name'>`; the checker uses the TypeScript compiler to resolve them.

The optional tool combines resolved TypeScript types, statically available SQL, statement Describe
and the configured encoder/decoder contracts. It reports definite contradictions and explicitly
identifies properties it cannot establish. It does not prove arbitrary SQL or JSON shapes correct.
Automatic runtime checks would require generated runtime type information and are deferred.

## Targeted operation

Illustrative commands; the executable and options do not exist yet:

```sh
pgclear check --project tsconfig.json
pgclear check --project tsconfig.json --file src/users.ts
pgclear check --project tsconfig.json --file src/users.ts --lines 40:85
```

File/range selection limits which query sites are checked, not the TypeScript context loaded to
resolve imports, utility types and aliases. A range selects complete query sites intersecting its
inclusive line numbers. Resolve supported API symbols through imports rather than treating every
function named `sql` or `query` as pgclear. Do not import the application or evaluate parameter
expressions to discover queries. No Bind or Execute is sent for inspection; Describe still performs
normal PostgreSQL parse/analysis and can take locks.

Diagnostics should include file/line/column, parameter or result-column location, expected and
observed representations, and a stable diagnostic code. Offer readable and structured output.
Report checked sites, mismatches and unchecked sites/properties separately; no discovered queries
must not look like successful validation of an entire file. Definite mismatches fail the command.
An explicit strict coverage policy may also fail when selected sites cannot be inspected. Nullability
and JSON properties left as caller assertions must remain visible without requiring their proof.

## Minimal SQL template candidate

Proposed authoring shape, not an existing export:

```ts
type UserSummary = Pick<Database['user'], 'id' | 'name'>;

const result = await db.query(sql<UserSummary>`SELECT id, name FROM app.users WHERE id = ${id}`);
```

The tag would synchronously produce statement text and values, with a type-only association to
`UserSummary` so `query` can infer its row type. It neither executes SQL nor opens a connection.
Initially each interpolation is one bound value: the example produces `WHERE id = $1` and `[id]`. Preserve
existing strict inputs, including `json(...)` and `param(...)`; strings are values, never identifiers
or raw SQL. The first tag trial excludes composition; the bounded extensions below are subsequent
proposals, not requirements for that trial. Arbitrary identifier/raw SQL interpolation and general
composition remain outside the proposed checkable surface. Ordinary text/values statements remain
supported and can be inspected when their SQL is recoverable.

This narrow tag is parameter binding convenience, rather than SQL composition policy. It is a
reasonable candidate for the standalone driver because it requires no table model or Tenon. Settle
its exact API and placeholder/context rules through a small trial before adding public signatures.

For tooling, literal chunks determine SQL text and interpolation AST nodes identify parameters and
their TypeScript types directly. There is no need to run interpolation expressions. Initially check
direct, statically recoverable calls; report dynamic SQL, unresolved generics and unsupported wrappers
as unchecked. A later Tenon integration can expose equivalent information without making the tool
understand every SQL builder or execute arbitrary application code.

## Composition frontends and practical limits

Runtime rendering and static recovery are separate responsibilities. Tenon's current `SqlQuery`
already exposes finished text, values and a type-only row association. That is useful at execution,
but ordinary runtime values do not retain the TypeScript input/result types or their source spans.
Passing only a rendered statement to the driver cannot implement a codebase checker.

Keep shared comparison and database inspection separate from source extraction. A source frontend
would supply recoverable SQL variants, ordered parameter types and encoding information, the expected
row type, and source locations. pgclear's frontend recognizes its narrow value-only tag; a Tenon-owned
frontend can recognize Tenon's composition rules. Identify APIs by resolved import symbols, including
aliases/re-exports, rather than the spelling `sql`. A common command could use both frontends without
requiring the runtime driver to own fragments or object expansion. Do not build a public plugin
framework before a small integration demonstrates the required interface.

Static fragments and literal-key expansion can be recoverable; composition is not inherently
uncheckable. Runtime-selected projections, identifiers, optional assignment keys and arbitrary helper
functions may produce unknown or too many SQL variants. Enumerating a few supported variants is
different from running the application with invented values. Keep unsupported cases visible and
never claim one described variant validates every branch. Generic wrappers can also hide the
concrete result type and parameter configuration from a query site.

The feasibility claim is limited: a focused checker for recognized calls and common data types is
practical; broad support for arbitrary TypeScript programs and every builder operation is a separate
static-analysis project. The shared engine and minimal tag are still unimplemented. A command that
finds no contradiction must retain its coverage and caller-assumption diagnostics.

## Bounded expansion, fragments and choices

These are proposed extensions beyond the first value-only tag trial. The maintainer's intended
composition ceiling is shaped expansion, recoverable fixed fragments and explicitly finite choices,
not a general fragment typing language or an arbitrary-program evaluator.

Expansion would use a resolved object type as its declared input shape and check that shape against
the target columns and input encoding rules. TypeScript types remain the authoring contract; no
separate runtime schema is required. Structural types do not establish an exact runtime key set,
optional properties may be absent, and types are erased at execution. Treat those as caller
assumptions when enumerating runtime properties; restricting rendering to an exact key set would
require explicit columns or generated metadata. Settle omission/DEFAULT/SQL NULL, batch shape and
empty-input rules before implementing helpers. A representative expanded statement is not proof of
every omitted-column/default combination.

For fragments, require recoverable fixed SQL structure, including traceable constant references.
`const` alone is insufficient: it can contain a conditional or arbitrary function result. Preserve
fragment structure against runtime mutation. Bound parameter values can vary while structure stays
fixed. Inspect fragments in their completed statement context; a fragment need not be valid SQL by
itself. Do not try to infer arbitrary fragment-returning function behavior.

Illustrative finite-choice candidate, not an implemented API:

```ts
const orderBy = sql.choose(
  {
    created: sql.fragment`created_at`,
    updated: sql.fragment`updated_at`,
  },
  () => (isCreatedAt ? 'created' : 'updated'),
);

const query = sql<UserSummary>`SELECT id, name FROM app.users ORDER BY ${orderBy}`;
```

The checker reads a statically recoverable option map and checks every complete query variant. It
never runs or analyzes the selector function's implementation to decide reachable alternatives.
The selector must return an option key; runtime also verifies own-key membership before dispatch,
including for JavaScript callers or type assertions. No fallback to arbitrary SQL is allowed.
Snapshot the finite option structure, choose one alternative once during statement construction,
and bind only that alternative's parameters. A synchronous callback, if retained, runs once during
construction; a direct selected-key argument is a simpler API candidate. Neither exact signature
is settled. Selector failure or an invalid key fails before sending the operation.

Each alternative is checked in context against the declared result type and its own ordered input
types. Do not require alternatives to have identical text or parameters; preserve placeholder
renumbering and source locations per variant. If alternatives return different columns/types, the
declared row type must accommodate them under the same compatibility rules as ordinary statements.
Multiple independent choices require checking their combinations: two binary choices can produce
four complete statements. Use a bounded analysis budget and deduplicate equivalent cases; exceeding
the budget reports incomplete coverage, never a fully checked result after sampling a few cases.
Keep dependent alternatives together in one explicit choice rather than analyzing arbitrary control
flow for correlations.

Unsupported fragments produce a located diagnostic, not abandonment of the entire file or project.
Continue independent TypeScript/input-kind checks, other recoverable variants and other queries.
An unknown SQL chunk can change syntax, scope, parameter types or output shape, so do not remove it
or insert invented SQL and claim the surrounding statement was validated by PostgreSQL. Mark the
affected database-dependent checks incomplete. For example, report `unsupported fragment; parameter
types and result metadata not verified`, alongside any independently established diagnostics.
Strict coverage mode fails for such selected queries; known mismatches still fail in normal mode.

## Input and result compatibility

Check both directions, using different evidence:

- Inputs: resolved interpolation/values types, driver-supported values, explicit parameter encoders
  and PostgreSQL's described parameter types. A JS type need not match the corresponding read type:
  pgclear can encode a string for a PostgreSQL int8 parameter while decoding int8 results as bigint.
  A broad `number` or `string` type alone cannot prove range, integer or textual-format validity.
- Results: expected TypeScript row properties, exact ordered field names and selected decoder output.
  Missing required columns and definitely incompatible decoded values are errors. TypeScript's
  structural object types do not by themselves require rejecting extra returned columns; duplicate
  object-column names still need a diagnostic. Honor unions, nullable types and custom decoder
  contracts rather than comparing PostgreSQL names directly with TypeScript names.

Nullability and nested JSON shape remain caller assertions unless the checker has supporting
evidence. A source `NOT NULL` flag alone does not prove a joined result non-null. Describe identifies
JSON's database type, not its members. A successful compatibility check means no established
contradiction under the reported coverage; it does not certify all values or every execution path.

Use the intended role, search path, schema and codec/encoder configuration. Do not assume default
codecs for an unresolved configuration, reuse result mappings as input policies, or persist local
extension OIDs as portable identities. Parameter expressions are never sampled or executed. Queries
needing type hints must obtain them from explicitly supported parameter declarations rather than
invented application values.

## Small implementation trial

Before a broad framework or release commitment:

1. Prove the template candidate's row inference and value binding against the existing statement API.
2. Discover direct typed query sites using the project's TypeScript program, including `Pick`, indexed
   access, imported aliases, nullable unions and nested JSON types.
3. Check selected sites through public Describe and a minimal encoder/decoder representation contract.
   Test file/range selection and verify inspection does not execute the application statements.
4. Exercise definite input/result mismatches, compatible encodings, unsupported sites, useful source
   locations and honest coverage output. Keep PostgreSQL 16/18 and packed-consumer gates applicable.

This is separate from named preparation, streaming and COPY; it neither requires nor begins M5.
