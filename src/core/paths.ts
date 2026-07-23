import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function home(): string {
  return homedir() || process.env.HOME || process.env.USERPROFILE || ".";
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

/** Codex home whose non-auth data is shared by every managed profile. */
export function baseCodexHome(): string {
  return envOr("CODEX_PROFILE_MANAGER_BASE_HOME", join(home(), ".codex"));
}

/** Manager-owned state. It intentionally lives outside CODEX_HOME. */
export function dataRoot(): string {
  const explicit = process.env.CODEX_PROFILE_MANAGER_HOME;
  if (explicit) return explicit;
  const configRoot = envOr(
    "XDG_CONFIG_HOME",
    process.platform === "win32"
      ? envOr("APPDATA", join(home(), "AppData", "Roaming"))
      : join(home(), ".config"),
  );
  return join(configRoot, "codex-profile-manager");
}

export function profilesFile(): string {
  return envOr("CODEX_PROFILE_MANAGER_PROFILES_FILE", join(dataRoot(), "profiles.json"));
}

export function profileHomesDir(): string {
  return envOr("CODEX_PROFILE_MANAGER_PROFILES_DIR", join(dataRoot(), "profiles"));
}

export function profileHome(slug: string): string {
  return join(profileHomesDir(), slug);
}

export function profileMutationLockPath(slug: string): string {
  return join(profileHomesDir(), `.cpm-mutation-${slug}.lock`);
}

export function profileLifecycleLockPath(slug: string): string {
  return join(profileHomesDir(), `.cpm-lifecycle-${slug}.lock`);
}

function pathEntries(): string[] {
  return (process.env.PATH || "").split(delimiter).filter(Boolean);
}

export function isOnPath(directory: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  return pathEntries().some((entry) => normalize(entry) === normalize(directory));
}

function isWritableDirectory(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Directory used for codex-<slug> launchers. */
export function launchersDir(): string {
  const explicit = process.env.CODEX_PROFILE_MANAGER_BIN_DIR;
  if (explicit) return explicit;

  const preferred = join(home(), ".local", "bin");
  if (pathEntries().includes(preferred) && isWritableDirectory(preferred)) {
    return preferred;
  }
  for (const dir of pathEntries()) {
    if (isWritableDirectory(dir) && !isSystemDirectory(dir) && !isTransientDirectory(dir)) {
      return dir;
    }
  }
  return preferred;
}

function isSystemDirectory(path: string): boolean {
  if (process.platform === "win32") {
    const root = (process.env.SystemRoot || "C:\\Windows").toLowerCase();
    return path.toLowerCase().startsWith(root);
  }
  return /^\/(?:bin|sbin|usr(?:\/|$)|System(?:\/|$))/.test(path);
}

function isTransientDirectory(path: string): boolean {
  return /[\\/](?:_npx|node_modules[\\/]\.bin)(?:[\\/]|$)/.test(path);
}

/** Resolve the real Codex executable, never a codex-<profile> launcher. */
export function resolveCodexBinary(): string {
  const explicit = process.env.CODEX_PROFILE_MANAGER_CODEX_BIN;
  if (explicit) return explicit;
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const dir of pathEntries()) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

/** Current manager entry point, used by durable launcher scripts. */
export function resolveSelfBinary(): string {
  return process.argv[1] || "codex-profile-manager";
}

export function launcherName(slug: string): string {
  return `codex-${slug}`;
}

export function launcherPath(slug: string): string {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return join(launchersDir(), launcherName(slug) + suffix);
}
