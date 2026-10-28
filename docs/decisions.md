# Design decisions

Accepted on 2026-10-28. These are implementation constraints; see [development](development.md)
for the implemented subset. Superseded entries preserve historical design discussion.
Amend details in place while the initial design is unimplemented; record a superseding decision for
a meaningful reversal. The engineer maintaining the project owns these decisions; no review board
or separate approval workflow is required.

## D01 — Standalone driver; Tenon is a consumer

Accept finished SQL and separate parameters. Keep schema inference, SQL fragments, migrations and
affected-row policy in Tenon. Ship as one ESM TypeScript package with declarations and Node 24 as the
initial runtime. A driver-native query builder would duplicate Tenon and enlarge the safety surface.
Other runtimes are deferred until a real consumer needs them.

## D02 — Own the protocol and lifecycle

Implement protocol framing, session state and request dispatch directly using Node primitives.
Do not wrap the full pg client or fork Postgres.js. Reusing pg-protocol was considered, but its
current DataRow parser converts fields to strings and rejects binary parser mode; the new core must
preserve wire bytes and format metadata. Owning framing adds tests and maintenance, but avoids
depending on another driver's internal lifecycle and preserves a future binary path. Use documented
PostgreSQL protocol behavior as authority. Revisit dependencies for a demonstrated need, particularly
authentication normalization; do not invent cryptographic algorithms or copy code without licenses.

## D03 — Expiring session capabilities

A connection never resurrects; a pool can replace it with a new connection. Every lease and child
scope has an expiring generation. Handle expiration precedes cleanup and physical reuse. This directly
addresses lost-transaction and stale-reservation hazards. Listener reconnect supervision is explicitly
different: a stable registration handle owns replaceable connections and reports generations/gaps.

## D04 — Explicit execution modes and preparation

Extended protocol for ordinary queries, including zero-parameter queries. Separate session-only
simple-protocol `script` for deliberate multi-statement SQL. Description without execution is public.
Named prepared statements are explicit session-owned handles, without an unbounded automatic cache
or automatic invalidation retries. This makes query cost and error ownership explainable and proxy
behavior testable. Unnamed statements still use PostgreSQL Parse/Bind/Execute; they are not a
different security model or a lack of protocol preparation.

## D05 — Loss-conscious values and scoped codecs

Default int8 to bigint, numeric and temporal values to strings, bytes to Uint8Array, and row counts
to bigint. JSON uses ordinary JSON.parse with its documented numeric limitations. Reject ambiguous
plain object/array/Date inputs; typed parameters choose JSON, PostgreSQL arrays, and custom encodings.
Codec registries are immutable and per connection/pool. Unknown text OIDs stay text; domain/extension
discovery is the consumer's responsibility. No automatic catalog fetch or mutation of shared parsers.
This intentionally differs from both existing drivers and requires explicit Tenon mapping changes.

## D06 — Sequential correctness before pipelining

The scheduler owns all operations from day one, but dispatches sequentially initially. Add bounded
opt-in pipelining only after request ownership, Sync recovery, serialization failure and cancellation
tests pass. pg 8.23.1 already supports pipelining; mere feature presence is not differentiation.
Streaming/COPY/managed scopes remain exclusive until their combinations are justified and tested.

## D07 — Cancellation retires active connections

Expose AbortSignal and operation deadlines. Before dispatch remove only that request. After dispatch,
attempt protocol cancellation on a separate connection and retire the original connection, bounded
by cleanup time. CancelRequest does not acknowledge a particular query; reusing the connection can
let a late cancellation strike its successor. Retirement sacrifices connection reuse to make that
race tractable. A future reuse optimization requires a proof and dedicated race tests. Never promise
that timing out a write means rollback, and preserve unknown COMMIT outcomes distinctly.

## D08 — Structured scopes without a SQL parser

Provide transaction/savepoint callbacks and raw exclusive sessions. Sequential managed scopes own
their operation queue, expire handles before cleanup, validate PostgreSQL state and commit tags, and
retain work/cleanup errors. Child savepoints exclude parent/sibling use to prevent rollback crossing
another operation. Allow valid manual-savepoint recovery. Do not parse arbitrary SQL to identify all
transaction control or session changes. Consumers such as Tenon can enforce additional SQL policy.
Explicit COMMIT inside a managed callback is caller misuse with unavoidable consequences.

## D09 — Explicit, bounded resources

Every acquisition queue, wire frame and buffered result has a finite default bound. Shutdown has a
deadline and a permanent no-new-work fence, disposes timers/late transports and settles requests.
Large results use backpressure through standard async iteration. Pool release checks transaction
state and preparation cleanup but does not claim to restore all session state or release arbitrary
advisory locks. Applications must clean up session state or discard the lease.

## D10 — Security and compatibility defaults are visible

Configuration is explicit; no global environment/pgpass discovery. TLS verifies certificates and
hostnames and never falls back silently. SCRAM validates proof/nonces and supports channel binding;
plaintext password authentication requires TLS or a Unix socket. Protocol 3.0 is requested until
3.2 is intentionally implemented. Structured events exclude SQL, values, passwords and cancel keys;
server diagnostic fields remain available to the caller and can contain sensitive values.

## D11 — Canonical docs before runtime publication

Root `docs/` owns accepted design and the implementation plan. Compile public signatures and examples
now; move the contract into actual source at the first implementation milestone. Keep npm publication
disabled until the release gate. Reuse the assigned private GitHub repository, shared Kequtech docs
synchronization action, and existing test database. Documentation checks do not claim runtime driver
coverage, and onboarding does not authorize a package release or visibility change.

## D12 — SASLprep tables as a focused dependency

M1 uses `@mongodb-js/saslprep` 1.6.1 instead of reproducing Unicode 3.2 character tables and bidi
rules or treating NFKC normalization alone as SASLprep. PostgreSQL falls back to the raw password
when preparation rejects it; tests compare both normalization and that fallback with PostgreSQL and
libpq. Crypto operations remain native Node functions. TLS channel binding uses the verified
certificate's signature hash (including SHA384), rather than assuming every certificate uses SHA256.
This is a concrete exception to the initial zero-runtime-dependency preference, supported by the
authentication correctness requirement.

## D13 — Buffered result limits charge framing and metadata

`maxResultBytes` counts complete DataRow wire bytes, including the row header and each field's length
word. Counting value payloads alone gives NULL and empty values zero cost and lets their row objects
grow without consuming the budget. M2 extends the same budget to field/parameter descriptions,
command tags and empty-query frames. Otherwise metadata-only Describe and zero-row scripts could
retain unbounded results without spending the row budget. Charge these across the whole operation,
including frames drained after a decoding error. Exceeding the limit disposes the connection and
settles queued work. The limit does not promise an exact JavaScript heap bound; large results use
streaming when available. No extra setting is added.

## D14 — Separate JSON values from typed SQL NULL

The [Tenon report](references/tenon-driver-migration-report.md) exposed an omission in the planned
parameter API: `param(null, codec)` deliberately bypasses the encoder and binds SQL NULL, so it
cannot express JSON null. M2 adds `json(value, type = 'jsonb')` for JSON.stringify of every JSON
value, including null and primitives. This helper is bound data, never a SQL expression. The normal
param null behavior stays unchanged. Add json/jsonb text codecs for exact numeric tokens and for
distinguishing returned SQL NULL from JSON null when the parsed defaults are insufficient.

## D15 — Derive default array decoding from scalar codecs

Use the same immutable scalar registry when decoding built-in array elements, with SQL NULL handled
before any element decoder. A scalar override therefore changes its default array representation;
an explicit array-OID codec still wins. The report's numeric-array precision regression becomes an
M2 gate: `9007199254740993.25` must remain an exact string alone and inside numeric arrays. Retain
native bigint for int8 in both shapes. Typed input encoders remain explicitly chosen by parameters.

## D16 — Keep pgclear's standalone contracts primary

The report's undefined-to-NULL and string-bigint recommendations partly target a pg-compatible
replacement. pgclear retains strict binds, native bigint values/counts and explicit array/JSON
parameters. On 2026-10-28 the maintainer explicitly allowed Tenon's promised contracts to change
and prioritized comfort in the upstream driver. This supersedes the initial requirement for the
adapter to preserve Tenon's undefined-to-NULL behavior. The M4 candidate adopts pgclear's contracts
without input normalization, a compatibility registry or another driver configuration form.

## D17 — Use native nested arrays for multidimensional parameters

Built-in array codec types must describe their decoded output faithfully. Since PostgreSQL array
OIDs do not distinguish dimensions, a flat-only TypeScript type would misrepresent nested results.
Use recursive `PgArray<T>` for the common typed array helpers, and encode rectangular native arrays
up to PostgreSQL's six-dimension limit. Reject ragged or nested-empty input before dispatch. Keep
lower-bound metadata outside the default JS representation. This replaces the initial requirement
for a custom codec for multidimensional input without adding wrappers or catalog discovery.

## D18 — Separate confirmed commit from reusable connection state

M3 treats a received COMMIT command tag as definitive commit evidence. ReadyForQuery establishes
that the session can accept another operation; losing it after COMMIT does not make the commit
unknown. Return the callback result and discard the broken connection in that case. If COMMIT was
dispatched without a definitive command/error response, return `PGCLEAR_COMMIT_UNKNOWN` and never
retry. A ROLLBACK tag fails. Deterministic fake-server tests cover all three boundaries.

## D19 — Reuse only after the operation's cleanup contract is satisfied

A managed transaction may reuse its connection after verified rollback; an arbitrary withSession
callback failure discards because its session cleanup is unknown. Ordinary SQL/encoding errors do
not force replacement when the session remains safely idle. Active cancellation always retires the
connection and owns its auxiliary transport through disposal. Pool shutdown attempts every resource,
then aggregates cleanup failures. Keep these policies in the owning pool/session modules rather than
adding a compatibility mode or an application-defined cleanup plugin.

## D20 — Trial consumers through packed artifacts before publication

Use pinned Tenon 0.3.1 source and local npm tarballs for M4. Exercise actual public exports and
compiled declarations in external consumers; publication is not needed to test the package boundary.
Keep the production Tenon checkout and published release unchanged. A separately reviewable adapter
patch adopts pgclear's native values, explicit parameters, session ownership and close contract.

An initial adapter attempted to normalize ordinary values and preserve Tenon's shutdown behavior.
The maintainer's clarification removed that requirement. Passing opaque parameters through unchanged
also removed the proposed need for an isParameter guard. No upstream API is added for this trial.
Adapt shared ORM policy to bigint counts; retain SQL composition, catalog interpretation and guarded
write checks in Tenon. Native pg listener/mock tests are not forced through a compatibility shim.

## D21 — Preserve protocol text; use PostgreSQL's array whitespace grammar

The Tenon agent's post-M4 review reproduced two data-corruption bugs despite the original passing
suites: TextDecoder removed a leading U+FEFF from values/names, and JavaScript `\s` stripped valid
Unicode characters from unquoted array elements. These were defects, not representation choices.
Both UTF-8 decoders now use `fatal: true, ignoreBOM: true`; protocol strings are data, not documents
whose first character may be discarded. Invalid UTF-8 still rejects.

Array parsing recognizes only space, tab, newline, carriage return, vertical tab and form feed as
syntax whitespace. Unicode spaces remain element data; quoted/escaped ASCII whitespace remains
data too. This follows PostgreSQL 16's
[array_isspace](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/utils/adt/arrayfuncs.c)
and PostgreSQL 18's
[scanner_isspace](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/parser/scansup.c).
Node documents the counterintuitive flag in
[TextDecoder options](https://github.com/nodejs/node/blob/v24.4.1/doc/api/util.md#new-textdecoderencoding-options).

Regressions cover repeated/leading U+FEFF, protocol metadata/diagnostics, Unicode array edges and
whitespace-only elements, nesting/bounds, invalid UTF-8 and escaped ASCII controls. Real-server tests
compare arrays with independent JSON output and compare parser input with PostgreSQL's own parser.
The packed Tenon fixture runs the same Unicode cases against pg and pgclear. M5 remains on hold
while correctness and applicable M4 adoption gates are addressed.

## D22 — Describe and decoder contracts support external type generation

Historical discussion: final tooling ownership is decided by D25. A codec-description API remains
unimplemented and must be justified by a concrete driver-consumer need.

The generator-first workflow below is superseded as the preferred path by D23. Its Describe and
selected-codec requirements remain applicable; generation remains a possible separate consumer.

The maintainer supplied a [deeper Tenon review](references/tenon-typed-query-review.md) after the
Unicode fixes. Retain public Describe as the authoritative statement metadata source. SQL discovery,
query registration, catalog interpretation, TypeScript rendering, generated wrappers and optional
nullability analysis belong in Tenon or separate tooling. pgclear does not need a SQL parser or a
generation CLI to support them. This refines the suggested generator alongside pgclear into a
consumer-owned workflow with reusable driver metadata.

Accept the requirement for public introspection of the selected decoder's read representation.
There is no such API today; choose its exact signature and descriptor shape through a small consumer
trial before implementation. Prefer language-neutral scalar/recursive-array descriptors and an
explicit unresolved custom contract over TypeScript source strings in the driver. Resolution must
agree with actual decoding: explicit array overrides win, scalar overrides affect derived built-in
arrays, raw and parsed JSON differ, and unknown text OIDs remain strings. Account for nullable array
elements and unknown dimensions. Catalog labels alone cannot establish the selected JS output.

A custom decoder's erased generic or function body cannot recover its TypeScript return type.
Tooling needs an explicit application mapping for such decoders; missing mappings must produce a
diagnostic rather than silently use default types. Keep parameter binding policy separate from read
representation. Metadata describes a codec contract, not runtime validation of decoder output.

An initial consumer workflow can describe authored SQL files after migrations in the intended
role/search path, then emit wrappers embedding the exact SQL and check generated output in CI.
Keep output nullability conservative, JSON shapes unknown and duplicate object-column names errors
unless an explicit policy resolves them. Regeneration detects changes represented in its inputs and
metadata; it cannot prove all schema behavior or every dynamic SQL variant unchanged. Do not persist
database-local extension OIDs as portable runtime type identities.

Saved SQL files are application source. They need not become database objects. PostgreSQL views or
SQL functions can be legitimate authored query sources; session-scoped prepared statements concern
execution reuse. None replaces decoder mapping or supplies complete TypeScript/nullability contracts.
Named preparation remains M5 work and is not a prerequisite for generation. M5 stays on hold.

## D23 — Check ordinary TypeScript query types intentionally

Superseded by D25: generation and checking are Tenon responsibilities. The value-only tag remains.

The maintainer rejected separately authored runtime contracts: existing TypeScript types, including
`Pick<Database['user'], 'id' | 'name'>`, should express expected results. Prefer an optional command
an engineer or coding agent can target at a project, file or line range, checking both input and
result compatibility against PostgreSQL and configured conversion contracts. Ordinary execution
trusts declared types. Default runtime schema checking and generated validation are not adopted.

This supersedes D22's SQL-file/generated-wrapper workflow as the first typing tool to explore. Keep
SQL files and generation available to separate consumers, without requiring them for this workflow.
Report definite contradictions separately from unproven nullability/JSON shape and undiscovered or
unsupported query sites. Inspect source without running application code or parameter expressions.

A minimal value-only `sql<Row>` tag is a proposed driver-level convenience: produce SQL text/binds
and preserve a type-only result association. It would make interpolation types directly available
to the checker without introducing identifiers, fragments, object expansion or SQL composition
policy. It is not implemented or added to the public signature contract yet. Preserve text/values
queries. See [query checking](references/query-tooling-exploration.md) for the candidate workflow and small trial; no new
runtime API or feature milestone starts with this decision.

## D24 — Keep conversion knowledge upstream; bound checkable composition

Superseded by D25: pgclear does not own the proposed generation/checking or composition helpers.

The maintainer's follow-up discussion places canonical conversion/type descriptions with the driver
that performs conversion. pgclear-owned optional generation and checking can share that model;
Tenon must not maintain a second interpretation of pgclear's codecs. The CLI/compiler dependencies
need not load during normal driver execution. This is a design direction, not an implemented type
generator, new runtime API or first-release tooling commitment.

The proposed authoring ceiling is shaped expansion, statically recoverable fixed fragments and a
finite `sql.choose`-style operation. This extends D23's minimal tag candidate without adding arbitrary
SQL composition or a fragment typing language. Expansion types are trusted declarations, with
explicit limits around structural extra keys, optional properties and runtime type erasure.

A choice declares all SQL alternatives independently of an arbitrary runtime selector. Check all
recoverable complete variants without invoking the selector, and enforce runtime selection from
the declared keys before dispatch. Multiple choices can multiply variants; bound analysis and report
incomplete coverage rather than silently sample. A merely `const` variable does not establish fixed
fragment structure. Unknown fragments permit independent checks to continue, but an incomplete SQL
statement cannot yield trustworthy PostgreSQL parameter/result metadata by substituting fake SQL.

See [bounded composition](references/query-tooling-exploration.md#bounded-expansion-fragments-and-choices) for the candidate
semantics and unresolved API details. Prove the small value-only checker first; bounded extensions
are later experiments. M5 remains on hold and neither Tenon's checkout nor its public API changes.

## D25 — Driver only; value-bound tags and classic query execution

The maintainer made the final boundary explicit: pgclear does not own type generation or a check
operation. Tenon owns those tools and may develop its own SQL authoring/composition policies.
The D22–D24 exploration is preserved as historical context, not a pgclear implementation commitment.
No fragment, expansion, chooser, runtime result schema, TypeScript compiler integration or automatic
catalog discovery is added to the driver. pgclear remains the authority on actual value conversion
and exposes faithful PostgreSQL metadata; any future codec-description API must address a concrete
consumer need without becoming a generation/checking framework.

Expose a value-only `sql<Row>` tag consumed by `query`, with row inference from the tag, and a
separately named `queryClassic<Row>(text, values, options?)` for classic callers. An unannotated tag
leaves result values unknown. Types remain caller assertions, with no runtime result validation.
The tag produces a readonly `[text, values]` tuple and binds every interpolation; it cannot splice
identifiers or SQL. Classic tuples and existing text/statement-object forms remain accepted by
`query` so existing consumers need no facade. Existing explicit `query<Row>` calls remain supported;
new tagged examples put the type on `sql<Row>`.

Both entrypoints share the same operation ownership, strict parameter validation, codec selection,
encoding, cancellation and result path on connections, pools, leases and transaction scopes. Keep
JSON/arrays explicit through `json`/`param`. Do not evaluate codecs or execute SQL when constructing
a tag. Freeze tuple/values structure and retain the existing rule that mutable bound data must stay
unchanged until settlement. M5 was still on hold at this checkpoint; D26 records its later
development-readiness decision without changing this product boundary.

## D26 — Resume focused driver work; keep adoption evidence separate

The maintainer authorized moving on after committing completed work if the driver is ready.
The two known Unicode blockers are fixed; PostgreSQL 16/18 CI passed for `e742fbf` in
[run 40642777907](https://github.com/kequtech/pgclear/actions/runs/40642777907), and the later query
API passed 106 local checks plus the isolated 17-case candidate trial. No new failure blocks the
next protocol slice. The newer query API checkpoint's own PostgreSQL 18 result remains unverified.

Resume development as M5a (explicit preparation), then M5b (portals/streaming), then M5c (COPY).
This supersedes the broad hold tying all M5 development to completed Tenon adoption. Full consumer
regression porting, PostgreSQL 16/18 adoption runs and deployment evidence remain required before
claiming Tenon replacement is validated. They do not require recreating pg's API or blocking driver
features that a future adoption will itself need. Do not mark those adoption gates completed.

The [handoff](m5-handoff.md) records the evidence, ownership question to resolve and bounded M5a
acceptance cases. Earlier hold statements in superseded decisions describe their historical state.
No M5 runtime feature is claimed implemented by this readiness decision.

## Deferred decisions

These do not block the sequential core: pipelining configuration shape; binary result selection;
custom socket factories; protocol 3.2 negotiation; CommonJS; multi-host discovery; replication; public
COPY record encoders; optional custom array constructors; and detailed public partial-script errors.
Do not expose placeholder options for them. Any blocking discovery in M1/M2 should amend the affected
accepted decision and signatures before later milestones build on it.
