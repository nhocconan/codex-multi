# Testing

Codex Multi uses Vitest for behavior tests and TypeScript's compiler
for static checks. The tests use temporary directories and fake credentials;
they never read or print the developer's real tokens.

## Run everything

```bash
npm run verify
```

That command runs:

1. `tsc --noEmit`
2. all Vitest tests
3. the production bundle
4. a bundled CLI version smoke test

## Version and release checks

Use `npm version <version> --no-git-tag-version` for a version bump. The npm
`version` lifecycle hook runs all verification and `npm pack --dry-run` after
updating package metadata. Update the source version fallback and changelog in
the same change. For direct metadata edits, run `npm run version` explicitly.

Publishing is a separate step: create the matching `v<version>` GitHub Release
to run `.github/workflows/release.yml`, or use authenticated `npm publish`.
The workflow supports npm trusted publishing with a configured GitHub trusted
publisher, or the existing `NPM_TOKEN` secret. Check the registry version and
the actual `npx --yes --package=codex-multi@latest codex-multi --version` output
before reporting the release as available.

## Test layers

- Unit tests cover registry validation, auth inspection, config isolation,
  launcher ownership, argument parsing, and environment scrubbing.
- Desktop alias tests build bundles against a fake `.app` under
  `CODEX_MULTI_APPS_DIR` with `CODEX_MULTI_NO_NATIVE_TOOLS=1`, so the
  macOS-only logic runs on every CI platform without `open`, `codesign`, or
  `lsregister`.
- Icon tests round-trip PNG members of `.icns` containers (extraction, badge
  compositing, box-filter downscaling, iconset layout) in pure JS, so they run
  unchanged on Linux and Windows CI.
- Desktop runtime tests mock process enumeration and native tool callbacks;
  they cover running-profile mutation guards, scan failures, startup timeouts,
  and exact process matching without launching the installed desktop app.
- Regression tests cover profile and alias collisions, staged replacement and
  registry rollback, disabled desktop data renames, unknown-field preservation,
  separated login, shell environment scrubbing, and malformed icon fallback.
- Integration tests import a fake file-based login and launch a fake Codex
  executable through a real profile home.
- Packaging is checked with `npm pack --dry-run`.
- GitHub Actions runs typecheck, tests, build, tarball installation, and binary
  smoke checks on Node 18 and Node 22 across Ubuntu, macOS, and Windows.

## Conventions

- Test files live in `test/` and use the `*.test.ts` suffix.
- Every test owns a unique temporary directory and removes it afterward.
- Never place a real API key, access token, refresh token, or `auth.json` in a
  test fixture.
- Guard Unix permission assertions and symlink assumptions on Windows.
- Error paths and both sides of conditionals should have behavior assertions.

Desktop launch-boundary tests cover exact profile paths, ambient credential
scrubbing, preservation of custom MCP environment, native open/startup failures,
and absence of URL-scheme registration in alias bundles. Live connector OAuth
approvals require verification in the intended account; they are not covered by
the mocked launch tests.

Callback-router tests cover opt-in installation, root ownership, foreign bundles
and LaunchAgents, malformed saved state, exact-handler registration, rollback,
missing-bundle recovery, and disable behavior. On macOS, native tests compile the
Swift helper and run production URL/path/queue validators without changing the
system handler. The installer explicitly targets macOS 12+; native registration
is verified through effective URL routing before success is reported.

Live smoke checks on macOS validated callback-handler enable/disable restoration,
profile discovery for an existing and a throwaway separated profile, and private
separated-home files. Real third-party approvals still require service consent
and confirmation in the intended account; automated tests do not certify every
connector's server behavior.
