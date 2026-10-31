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
  modify the official app bundle. Desktop aliases never register the `codex:`
  URL scheme. The separately enabled callback router may register it only
  after explicit opt-in, and must restore the previous handler on disable.
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

## Security rules

1. Replace files through `src/core/atomic-write.ts`: use unpredictable temporary
   names, exclusive creation, permissions set before rename, and cleanup on failure.
   Never implement a local `writeFile(temporary)` then `rename(temporary, target)`.
2. Profile homes must be real directories separate from the base home. Managed
   credentials and backups must be regular files with one link; reject symbolic
   and hard links before reading, recovering, or launching a profile.
3. Read bundle ownership from top-level plist string values, never text matches.
   Reject duplicate keys and malformed documents before executing or deleting bundles.
4. An unobserved desktop startup remains pending after timeout or error. Do not
   replace credentials, rename, or remove it until startup is observed or the user
   explicitly confirms cancellation through the pending-launch recovery command.

| Concern | Rule | Enforcement |
| --- | --- | --- |
| Atomic replacement | §1 | `scripts/audit/atomic-writes.mjs`, `npm run verify`, CI security job |
| Credential isolation | §2 | `test/auth-isolation.test.ts`, shared isolation guard |
| Bundle ownership | §3 | `test/plist.test.ts`, desktop/router ownership tests |
| Delayed desktop startup | §4 | `test/desktop-runtime.test.ts`, `test/reset-pending.test.ts` |

## Verification

```bash
npm run typecheck
npm run audit:security
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

## Connector callback routing

- Keep OAuth URLs in memory only; never log them, write them to disk, or pass
  them as child-process arguments.
- Require an explicit user choice among running Codex processes; deliver only
  to the selected PID, revalidate it, and never broadcast or fall back.
- Router bundles and LaunchAgents require exact project/root ownership markers.
- Keep callback routing optional and restore prior handler ownership on disable.
