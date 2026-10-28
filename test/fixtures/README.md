# TLS test fixtures

These certificates and the private key are public, test-only material with no external authority or
production use. The localhost certificate is self-signed with SHA384, covers localhost/127.0.0.1,
and is valid for ten years from fixture creation. The second certificate is an unrelated trust root.

They test certificate trust, hostname verification, and selecting the correct channel-binding hash.
Never configure these credentials outside the test harness. Regenerate with OpenSSL if they expire.
