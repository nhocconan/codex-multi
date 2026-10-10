# Agent guidelines — codex-multi

## Product invariants

- Never copy a selected profile over the user's base `~/.codex/auth.json`.
- Every launched profile must use its own `CODEX_HOME` and real `auth.json`.
- Shared Codex data is linked from the base home; credentials are never linked.
- Never print, log, or store auth contents in the profile registry.
- Only remove launchers containing this project's ownership marker.
- Preserve unknown registry fields and evolving `auth.json` fields where possible.
- Desktop aliases launch the official desktop app unmodified, with the
  profile's `CODEX_HOME` and a per-profile Electron user data dir; never
  modify the official app bundle or register the `codex:` URL scheme.
- Only touch `.app` alias bundles whose `Info.plist` carries this project's
  `CodexMultiSlug` marker; never replace a foreign app of the same name.
- An alias target must belong to the same slug and manager data root. Serialize
  bundle writes, finish staging before replacing existing aliases, and preserve
  original bundles when rollback cannot complete.
- Desktop launches must serialize with profile mutation, and active desktop
  profiles must block credential replacement, slug rename, and removal.
- Desktop launchers must not inherit ambient `CODEX_HOME`,
  `CODEX_ELECTRON_USER_DATA_PATH`, or auth environment variables.
- Alias icons are derived from the installed app's own icon at install time;
  never bundle third-party artwork, and always fall back to the original icon
  when badge rendering fails.

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

## Version upgrades and npm releases

- Use `npm version <version> --no-git-tag-version` to bump releases; its version
  hook runs verification, rebuilds the CLI, and checks the npm tarball. Keep
  `package.json`, `package-lock.json`, `src/version.ts`, and the changelog aligned.
- If version metadata is edited directly, run `npm run version` before handoff.
- A version upgrade is not a completed npm/npx update until that version is
  published. For an authorized release, publish through the GitHub Release
  workflow (`v<version>`) or authenticated `npm publish --access public`.
- Verify `npm view codex-multi version` and
  `npx --yes --package=codex-multi@latest codex-multi --version` match the release.
  Existing profile launchers must be refreshed with
  `npx --yes --package=codex-multi@latest codex-multi sync` on each machine.
- If authentication or CI blocks publishing, report the blocker and explicitly
  say the npm release is still pending. Never claim local build success means
  users of npx have received the update. Never print or commit npm tokens.
