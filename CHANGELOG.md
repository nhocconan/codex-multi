# Changelog

All notable changes to this project are documented here.

## [0.2.2] - 2026-09-22

### Fixed

- Generated launchers now use tiered manager resolution:
  1. Recorded manager binary if present on disk;
  2. Dynamic `codex-multi` / `cpm` PATH discovery (avoiding ~2s npx startup overhead and working offline);
  3. Isolated `npx` fallback passing `--prefix <tmpdir>` so invocations never fail with `sh: codex-multi: command not found` when running inside directories whose `package.json` defines `codex-multi`.
- Quoted launcher command on Windows to fix cross-platform CI assertions.
- Separated `cpm doctor` findings into fatal errors (exit code 1) and advisory warnings (exit code 0 for duplicate credentials).
- Upgraded dependencies to latest secure releases, resolving all audit vulnerabilities.

## [0.2.1] - 2026-07-24

### Fixed

- Generated `codex-<profile>` launchers now invoke the manager through
  `npx --package=codex-multi@<ver> codex-multi …` instead of `npx codex-multi@<ver> …`.
  The package ships two bins (`codex-multi` and `cpm`); the old form left npx to
  guess between them and, on a cold cache, could resolve to `cpm` and fail with
  `sh: cpm: command not found`. Naming the bin explicitly removes the ambiguity.
  Reordered `package.json` `bin` so `codex-multi` (matching the package name)
  comes first as a second line of defense.

## [0.2.0] - 2026-07-23

### Changed

- Rename the package and primary command to the shorter `codex-multi`.
- Make shared Codex skills a first-class feature: install a skill once under
  `~/.codex/skills` and use it from every account profile.
- Reserve `codex-multi` for the manager so it cannot collide with a generated
  profile launcher.

## [0.1.0] - 2026-07-23

### Added

- Run multiple Codex CLI accounts concurrently through `codex-<profile>` launchers.
- Add browser, device-code, API-key, access-token, and current-login import flows.
- Keep credentials isolated while sharing Codex config, skills, plugins, memories, and sessions.
- Add safe profile login rollback, rename, removal, synchronization, and local diagnostics.
- Support durable launchers for both global npm installs and one-off npx usage.
- Add cross-platform CI, security-focused unit tests, and an end-to-end launch test.
