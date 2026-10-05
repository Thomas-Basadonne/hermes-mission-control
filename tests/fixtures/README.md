# Provider usage fixtures

`codexbar-nous-usage.json` is a synthetic CodexBar `UsageSnapshot` fixture for
contract tests. Its Nous amounts and detail labels follow a sanitized upstream
test case; the fixture contains no credentials, account identity, or captured
user data.

This is **not** a captured successful `codexbar usage --provider nous --json`
response. The authenticated CLI payload has not been observed in this worktree.
The normalizer therefore accepts only the documented synthetic field names,
recognized plan labels, ISO timestamps, and strict USD value formats; unknown
rows are dropped instead of being forwarded. Live CodexBar serialization
compatibility remains unverified without a safe, redacted capture.
