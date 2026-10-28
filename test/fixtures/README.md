# TLS test fixtures

These certificates and the private key are public, test-only material with no external authority or
production use. The localhost certificate is self-signed with SHA384, covers localhost/127.0.0.1,
and is valid for ten years from fixture creation. The second certificate is an unrelated trust root.

They test certificate trust, hostname verification, and selecting the correct channel-binding hash.
Never configure these credentials outside the test harness. Regenerate with OpenSSL if they expire.

`lifecycle/child.ts` contains the typechecked subprocess scenarios for Describe, preparation,
streaming, COPY and pool cleanup. It loads the built package from `dist/`. The parent tests use
`helpers/subprocess.ts` to require natural exit despite hour-long operation deadlines, and the
shared fake-session helper retains startup and backend-key cancellation assertions.
