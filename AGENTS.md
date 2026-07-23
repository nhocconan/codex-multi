# Agent guidelines — codex-profile-manager

## Product invariants

- Never copy a selected profile over the user's base `~/.codex/auth.json`.
- Every launched profile must use its own `CODEX_HOME` and real `auth.json`.
- Shared Codex data is linked from the base home; credentials are never linked.
- Never print, log, or store auth contents in the profile registry.
- Only remove launchers containing this project's ownership marker.
- Preserve unknown registry fields and evolving `auth.json` fields where possible.

## Cross-platform tests

- Do not assert Unix mode bits on Windows.
- Use `node:path`; do not hard-code path separators.
- Symlink tests must tolerate Windows environments without symlink privileges.

## Verification

```bash
npm run typecheck
npm test
npm run build
node dist/cli.js --version
npm pack --dry-run
```

See `TESTING.md` for test layers and conventions. New branches and error paths
must ship with behavior tests; never use real credentials in fixtures.
