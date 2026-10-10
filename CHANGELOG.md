# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [0.3.0] - 2026-10-10

### Fixed

- Refuse alias collisions across profiles and manager roots; serialize bundle
  installation and keep previous bundles until a replacement commits.
- Restore aliases and desktop data when registry or filesystem updates fail,
  including renames of profiles whose desktop alias is disabled.
- Preserve unknown desktop registry fields and honor separated state during login.
- Block login, command-suffix rename, and removal while a profile's desktop
  instance runs; serialize alias launches with profile mutations.
- Scrub ambient credentials in alias launchers, refresh configuration before
  launching, and keep a bundled runtime independent of temporary npx caches.
- Escape names beginning with XML markup and fall back to the original icon
  for malformed PNG members. Enlarge badge colors and improve transparent edges.
- Correct the non-macOS guard test and add regression coverage for failures,
  ownership, concurrency, credential isolation, and desktop lifecycle handling.

### Added

- Optional macOS connector callback router: choose a running profile for each
  browser approval, with exact process delivery, no URL logging, and previous
  handler restoration on disable. The official app remains unmodified.
- README guide for enabling desktop aliases on existing profiles through the
  latest npx release, with launch, verification, and refresh commands.
- App integration guide clarifying shared plugins/MCP configuration and
  browser callback limitations; regression tests for the native launch boundary.

- Desktop app aliases (macOS): `cpm add --desktop` installs a per-profile
  alias app in `~/Applications` (named `<App> <Label>`, e.g. "ChatGPT Work")
  that opens the unmodified official desktop app with the profile's
  `CODEX_HOME` and its own app data directory, so multiple desktop instances
  run side by side, each signed into its own account. Spotlight, Raycast, and
  Dock pinning work.
- Distinct per-profile alias icons: each alias icon is the official app icon
  with a color badge (stable per-slug assignment; override with
  `--desktop-color`, revert with `auto`, opt out with `none`). Badges render
  locally from the app's own icon — no bundled artwork, no native image
  libraries — and fall back to the original icon whenever rendering is
  unavailable. Alias bundles record a `CodexMultiIcon` badge revision in their
  `Info.plist`, so `cpm sync` rebuilds bundles whose icon style or color
  changed and recreates bundles with a missing icon file.
- `cpm desktop <slug>` opens a profile's isolated desktop instance directly.
- `cpm edit <slug> --desktop / --no-desktop / --desktop-name / --desktop-color`
  and a "Desktop app alias" toggle in the interactive manager.
- `--separated` profile option to keep a profile's Codex state fully private
  instead of sharing base history, projects, and skills.
- `cpm sync`, `cpm doctor`, `cpm remove`, and `cpm list` now cover desktop
  aliases (marker-gated; foreign apps are never touched).
- `.codex-global-state.json` is private per profile so simultaneously running
  desktop instances never fight over one UI-state file.

### Changed

- `cpm edit <slug> --desktop` now always refreshes the alias bundle (name,
  icon, baked paths), even when nothing else changed.
- `cpm edit <slug> --desktop-name ""` resets a custom alias name back to the
  `<App> <Label>` default; the flag parser accepts explicitly empty values.
- Profile edits that only change desktop state (`--desktop`, `--no-desktop`,
  `--desktop-name`, `--desktop-color`) no longer prompt for the display name
  and slug.

## [0.2.3] - 2026-09-30

### Fixed

- Keep `app-server-daemon` and `app-server-control` private to each profile.
  Codex rejects symlinked daemon directories, preventing affected profiles from
  starting. Launch and sync now remove legacy links while preserving base daemon
  state, real profile daemon directories, and profile credentials.
- Run verification, build, and tarball checks during `npm version`; align the
  package lock version and prepare the release workflow for trusted publishing.

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
