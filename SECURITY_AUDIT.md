# Security and usability review — 2026-11-13

Scope: source hardening for CLI account dispatch, credentials, configuration,
shared state, generated launchers, macOS desktop aliases, callback recovery,
terminal interaction, packaging, and dependencies. Changes are included in release **0.3.3**. No real credentials were read and no real profile,
official app bundle, URL handler, or LaunchAgent was changed.

## Findings resolved in the working tree

| Severity | Weakness | Source | Resolution |
| --- | --- | --- | --- |
| High | CWE-863: higher-precedence config could select a shared credential store | `core/profile-home.ts`, `core/config-overrides.ts`, `core/launcher.ts`, `core/login.ts` | Parse TOML semantically, force file storage at root/named profiles, reject competing CLI storage, and apply an authoritative CLI override before literal argument passthrough |
| High | CWE-863: global flags before login bypassed mutation protection; logout lacked the desktop guard | `core/launcher.ts`, `core/login.ts` | Identify command boundaries, preserve root flags inside transactional login, and guard logout and backup restoration before changing active desktop credentials |
| High | CWE-200: ambient noninteractive API keys/workload identity could select another account | `core/environment.ts`, `core/desktop.ts` | Shared case-insensitive environment filtering for CLI/login/desktop; secret source variables are removed from login's environment after reading them for stdin |
| Medium | CWE-367 / CWE-459: credential read races and destructive backup restoration | `core/auth.ts` | Validate opened descriptors; restore atomically while retaining recovery material on failure; hide parser excerpts from errors |
| Medium | CWE-61: disguised credential aliases could be shared as ordinary state | `core/profile-home.ts` | Exclude symbolic/hard-linked credential aliases, dangling auth aliases, and directory aliases exposing credential homes; fail closed on incomplete sharing/cleanup |
| Medium | CWE-61: linked Electron data paths could share desktop identity | `core/desktop.ts` | Require real private desktop directories under the lifecycle lock; reject native `codex app` passthrough with the isolated desktop command |
| Medium | CWE-20 / CWE-400: unsafe ownership/recovery files and unbounded reads | `core/plist.ts`, `core/callback-router.ts`, `core/wrappers.ts` | Bound regular-file reads, avoid following launcher/plist links, reject linked router state/agents and self-restoration; constrain process scan duration |
| Medium | CWE-20: ignored flags/arguments could execute unintended manager operations | `cli.ts`, `commands/edit.ts`, `ui.ts` | Strict command schemas and login modes; partial scripted edits; EOF/cancellation/I/O cleanup; semantic doctor checks |

The filesystem findings require unsafe existing layouts, local access, or local
configuration. They are not evidence of a remote compromise. Account isolation
does not sandbox third-party MCP servers or override organization-enforced auth
requirements. Custom provider credentials retain their own configured behavior.

OpenAI documents both [file credential storage](https://learn.chatgpt.com/docs/auth#credential-storage)
and the [configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence)
that makes an invocation-level override necessary. The environment filter also
covers [documented noninteractive API keys and workload identity selectors](https://learn.chatgpt.com/docs/config-file/environment-variables#authentication-and-network).

## Verification and limits

- Full verification: 27 suites, **493 tests passed, 1 skipped**, typecheck,
  atomic-write source audit, production build, and bundled version smoke passed.
- Native Codex CLI **0.167.2**: seven smoke paths passed with synthetic credentials
  in a temporary home. Leading configuration flags, login status, named-profile
  exec help, top-level and subcommand help, and completion work through the bundled manager.
- Gitleaks scanned all available Git refs (21 commits) and the working tree with
  redaction; no leaks found. npm's dependency audit reported zero known
  vulnerabilities, including development dependencies.
- Four reviewed local Semgrep rules supplement manual review. They check
  shell-enabled subprocesses, dynamic code execution, common credential logging,
  and disabled TLS verification; this is a focused scan, not a complete SAST proof.
- Package inspection includes the bundled runtime, native callback helper, and
  the new pinned, dependency-free TOML parser's BSD license notice.

Repeated native launches performed **zero replacements of unchanged private
config files**. The icon benchmark against HEAD produced identical bytes, with
125.52 ms / 124.31 ms medians over twelve alternating samples; the 1% difference
is not treated as a meaningful speedup. Semantic TOML validation adds about
50 KiB to the JS bundle; this buys correctness rather than a startup speed claim.

Native Swift compilation and callback validators passed. Live app startup,
third-party OAuth consent, actual process-list truncation, and Windows/Linux
runtime behavior were not independently exercised in this review. Cross-platform
CI and a manual macOS app/connector smoke remain the checks for those surfaces.
There is no claim of absolute security or compatibility with every future Codex
release.

Reproduce locally (Gitleaks and Semgrep are optional installed tools):

```bash
gitleaks git --redact --no-banner --log-opts='--all' .
gitleaks dir --redact --no-banner --max-target-megabytes=2 .
semgrep scan --config scripts/audit/security.semgrep.yml --metrics=off \
  --disable-version-check --oss-only --no-git-ignore src
npm audit --json
npm run verify
npm run test:native-cli
npm pack --dry-run
node scripts/benchmark/icons.mjs HEAD
```

## Previous audit — 2026-10-31

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

Cross-platform CI exposed transient Windows rename contention during concurrent
replacements. Windows now retries only sharing/permission contention errors for
at most 500 ms; permanent errors preserve the destination and clean up the
temporary file. POSIX errors are returned immediately.

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
