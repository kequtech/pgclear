# SASLprep dependency evaluation

Status: the replacement is implemented. The dependency and its two transitive packages are removed.
The 20 credential cases agree with PostgreSQL/libpq on PostgreSQL 16.15 and 18.0, and native NFKC
agrees with both servers for every changing character allowed by the fixed stringprep tables.
The full driver check passes 232 tests on PostgreSQL 16.15; final consumer/matrix results are
recorded in [development](development.md).

`@mongodb-js/saslprep` 1.6.1 previously supplied password preparation for PostgreSQL SCRAM. It implements a
general authentication standard; the MongoDB namespace does not make it a MongoDB wire-protocol
dependency. SCRAM proof derivation, TLS and channel binding already use native Node modules.

[PostgreSQL's authentication contract](https://www.postgresql.org/docs/18/sasl-authentication.html)
requires SASLprep with fallback to the original password when preparation fails.
[RFC 4013](https://www.rfc-editor.org/rfc/rfc4013) includes Unicode 3.2 character tables, mappings,
NFKC normalization, prohibited/unassigned characters and bidirectional checks. JavaScript's
`normalize('NFKC')` covers only the normalization step. Removing preparation or normalizing every
password without those checks changes which credentials authenticate.

The installed dependency also brings `sparse-bitfield` and `memory-pager`. The local installation
occupies roughly 828 KiB across the three packages, including source tables and maps; the loaded
algorithm and compressed table modules are about 6 KiB of JavaScript. Installed size is not a
measurement of startup memory. The reason to remove it is a smaller dependency closure and direct
control of PostgreSQL compatibility, rather than an established performance gain.

## Observed compatibility gap

On 2026-10-29, a temporary-role probe compared the current driver and libpq against PostgreSQL
16.15. Ordinary normalization and prohibited/bidirectional fallback samples authenticated through
both clients. The password `\u1D2Cpass` authenticated through libpq but failed with SQLSTATE `28P01`
through pgclear. U+1D2C was unassigned in Unicode 3.2 but has a modern compatibility mapping to `A`;
the helper produces `Apass`, while PostgreSQL retains the original password.

The helper checks unassigned characters after normalization. PostgreSQL's
[SASLprep implementation](https://github.com/postgres/postgres/blob/REL_18_0/src/common/saslprep.c)
checks the mapped input as part of its preparation rules. A replacement must match the actual
server/libpq contract, including this ordering. The dependency is not a sufficient compatibility
oracle. This was a confirmed limitation of the previous preparation; the old authentication tests
did not cover it. The permanent regression now passes on both supported majors.

## Implemented replacement

`src/auth/saslprep.ts` is a small internal function. It preserves PostgreSQL's ASCII shortcut,
mapping precedence, mapped-input checks, bidi rules and complete original-password fallback.
`src/auth/saslprep-tables.ts` contains six generated Unicode regexes. The generator validates
range ordering and the pinned upstream source SHA256; regeneration is an explicit offline developer
action. PostgreSQL attribution is included in LICENSE. Networking, SCRAM cryptography, TLS and the
public API are unchanged.

The following plan guided the implementation:

1. Generate compact, sorted range tables from a pinned PostgreSQL source revision with recorded
   checksum and license attribution. Preserve the fixed stringprep tables; do not use modern
   Unicode property regexes as a substitute or maintain hand-selected exceptions.
2. Implement one internal preparation function using those tables and native NFKC normalization.
   Follow PostgreSQL's mapping/check ordering and preserve the complete original password on
   rejection. Keep the current function boundary; add no public configuration, injectable
   preparation hook, native addon or replacement runtime dependency.
3. Test table boundaries, RFC examples, supplementary characters, unassigned code points that
   normalize to assigned characters, prohibited values, normalization expansions, bidi combinations
   and inputs mapped entirely to empty. Validate native normalization against the supported Node
   and PostgreSQL versions instead of assuming their Unicode versions are identical.
4. Extend the existing temporary-role PostgreSQL/libpq authentication workflow, including
   `\u1D2Cpass`, on PostgreSQL 16/18. Run the driver and TLS/SCRAM-PLUS compatibility suites. Use
   the current library only as a secondary comparison, not the expected answer.
5. Remove the dependency and its unused transitive lockfile entries once the replacement passes.
   Recheck the packed consumer and attribution. No generator is needed at application runtime.

The maintenance responsibility is one small authentication routine and fixed data tables; Node
still owns normalization. PostgreSQL/libpq remains the compatibility oracle, including the case
where the former generic helper produced a different password.
