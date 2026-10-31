# Security and performance audit — 2026-10-31

Scope: this CLI, profile isolation, generated launchers, macOS aliases and callback
router, dependency lockfile, and CI/release configuration. Findings below were
confirmed by source inspection and synthetic behavior tests. No live credentials
were read, no official app bundle was changed, and no OAuth handler was changed
during testing.

## Findings resolved in 0.3.2

| Severity | Weakness | Affected source | Resolution |
| --- | --- | --- | --- |
| Medium | CWE-377 / CWE-61: predictable temporary files could follow preplanted links | `auth.ts`, `registry.ts`, `wrappers.ts`, `desktop.ts`, `icon.ts` | Exclusive unpredictable temporary files; private icon scratch directories; cleanup after failure |
| Medium | CWE-61: linked profile credentials or homes could defeat account isolation | `auth.ts`, `profile-home.ts` | Reject symbolic/hard-linked auth and backups, symbolic profile homes, and homes resolving to the base home |
| Low | CWE-22: invalid slug could create a lock directory outside the profile root | `paths.ts`, `registry.ts` | Validate slugs before constructing profile, lock, and launcher paths |
| Medium | CWE-20: text matching could accept ownership markers inside comments or nested values | `desktop.ts`, `callback-router.ts` | Shared strict plist parser accepts only top-level strings; duplicate keys and malformed input fail closed |
| Medium | CWE-459: interrupted router setup could lose the previous handler, and shutdown errors could skip rollback | `callback-router.ts` | Flush recovery state before registration; attempt shutdown and restoration independently; preserve uncertain recovery state/helper |
| Medium | CWE-362: startup timeout could release guards while an asynchronous desktop launch was still queued | `desktop-runtime.ts`, `desktop.ts` | Persistent pending marker blocks mutation; recovery requires explicit cancellation confirmation, an empty process scan, and both locks |
| High / Moderate | Published advisories in development dependencies: 4 affected packages (2 high, 2 moderate) | `package.json`, `package-lock.json` | Vitest/mocker 4.1.12, Vite 6.4.5, source-map-js 1.2.2; full and production-only audits report zero known vulnerabilities |

These filesystem findings require local access or an unsafe pre-existing layout;
they are not evidence of remote compromise. Runtime dependencies had no reported
advisories at scan time. Advisory databases change after this report.

## Performance evidence

`node scripts/benchmark/icons.mjs 0d3c837` compares the pre-audit pipeline against
the current implementation using a generated 1024px PNG. Twelve alternating
samples after warmup measured median **149.51 ms before / 123.15 ms after**
(17.6% reduction) on the development Mac. Every emitted filename and PNG byte
matched. This measures icon generation, not desktop app rendering or startup.

The callback chooser now filters unrelated applications before spawning `ps`.
No wall-clock speed claim is made for the chooser.

## Reproduction and coverage

```bash
gitleaks git --redact --no-banner .
gitleaks dir --redact --no-banner src
gitleaks dir --redact --no-banner native
semgrep scan --config p/javascript --metrics=off --disable-version-check --oss-only \
  --exclude node_modules --exclude dist --exclude test --json \
  --output /private/tmp/cpm-semgrep.json
npm audit --json
npm audit --omit=dev --json
npm run verify
npm pack --dry-run
node scripts/benchmark/icons.mjs 0d3c837
```

Initial Gitleaks scan reviewed 18 commits (670,066 bytes) and the source/native
working directories with no findings. Semgrep ran 74 rules on 27 tracked
TypeScript targets with no findings; this was a supplementary scan before the
new helper files were added. New helpers received behavior tests and manual
review. The atomic-write audit runs in `verify` and CI; CI separately checks
current npm advisories.

Native tests compile the Swift helper and exercise its validators without
changing the system URL handler. Router registration, rollback failures, and
desktop startup races use mocked native calls. Live third-party consent,
Gatekeeper delays, Windows/Linux behavior, and Dock presentation require their
respective runtime checks; local tests alone do not certify those environments.

## Running Dock icon limitation

Aliases retain per-profile color badges. The running official application's
icon cannot be changed by this manager through supported external APIs. Apple
exposes [`NSRunningApplication.icon`](https://developer.apple.com/documentation/appkit/nsrunningapplication/icon)
as read-only; Electron's [`dock.setIcon`](https://www.electronjs.org/docs/latest/api/dock)
runs inside the app's own main process. Per-profile running icons require
official app support. This release preserves the official app bundle.
