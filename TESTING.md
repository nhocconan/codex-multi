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
