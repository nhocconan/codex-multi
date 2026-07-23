# Changelog

All notable changes to this project are documented here.

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
