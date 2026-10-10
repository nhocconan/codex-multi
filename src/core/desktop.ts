import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { baseCodexHome, dataRoot, profileHome, profileHomesDir, profilesFile, profileLifecycleLockPath, profileMutationLockPath, resolveSelfBinary } from "./paths.ts";
import { findRegistered, loadRegistered, type Profile } from "./registry.ts";
import { renderBadgedIcns, type Rgb } from "./icon.ts";
import { VERSION } from "../version.ts";
import { withFileLock } from "./lock.ts";
import { ensureCallbackRouterHandler } from "./callback-router.ts";
import { waitForDesktopStartup } from "./desktop-runtime.ts";

const execFileAsync = promisify(execFile);

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const BUNDLE_ID_PREFIX = "io.github.nhocconan.codex-multi.profile";
const ALIAS_EXECUTABLE = "codex-multi-desktop";
const ALIAS_ICON = "AppIcon.icns";
/** Bump when alias icon rendering changes so sync refreshes existing bundles. */
const ICON_REV = "badge2";

/** Badge colors available for desktop alias icons. */
export const DESKTOP_COLORS: Record<string, Rgb> = {
  red: { r: 229, g: 72, b: 77 },
  orange: { r: 247, g: 107, b: 21 },
  yellow: { r: 255, g: 197, b: 61 },
  green: { r: 70, g: 167, b: 88 },
  teal: { r: 18, g: 165, b: 148 },
  blue: { r: 62, g: 99, b: 221 },
  purple: { r: 110, g: 86, b: 207 },
  pink: { r: 214, g: 64, b: 159 },
  cyan: { r: 0, g: 162, b: 199 },
  lime: { r: 153, g: 213, b: 42 },
};

export interface DesktopApp {
  /** Absolute path to the desktop .app bundle. */
  path: string;
  /** Display name from the bundle, e.g. "ChatGPT" or "Codex". */
  name: string;
  /** Resolved .icns inside the bundle, when present. */
  iconPath?: string;
}

export interface DesktopConfig {
  enabled: boolean;
  appPath: string;
  appName: string;
  aliasName?: string | undefined;
  color?: string | undefined;
}

export interface DesktopSyncResult {
  created: number;
  updated: number;
  removed: number;
  conflicts: string[];
  dir: string;
}

export function desktopSupported(): boolean {
  return process.platform === "darwin";
}

/**
 * Test-harness mode: native tools (open/codesign/lsregister/plutil) are
 * unavailable or unwanted, so platform gates open up and only portable
 * filesystem logic runs. Never set this for normal use.
 */
function harnessMode(): boolean {
  return process.env.CODEX_MULTI_NO_NATIVE_TOOLS === "1";
}

/** Directory that holds generated desktop alias bundles. */
export function desktopAppsDir(): string {
  return process.env.CODEX_MULTI_APPS_DIR ?? join(homedir(), "Applications");
}

/** Per-profile Electron user data directory (sign-in session, window state). */
export function desktopUserDataDir(slug: string): string {
  return join(dataRoot(), "desktop", slug);
}

/** Tolerant reader for the open-schema "desktop" profile field. */
export function desktopConfigOf(profile: Profile): DesktopConfig | undefined {
  const raw = (profile as { desktop?: unknown }).desktop;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const appPath = typeof record.appPath === "string" ? record.appPath : "";
  const appName = typeof record.appName === "string" ? record.appName : "";
  if (!appPath || !appName) return undefined;
  const aliasName =
    typeof record.aliasName === "string" && record.aliasName.trim().length > 0
      ? record.aliasName
      : undefined;
  const color = typeof record.color === "string" ? record.color : undefined;
  return { enabled: record.enabled === true, appPath, appName, aliasName, color };
}

/** Badge color for a profile: explicit choice, or a stable per-slug default. */
export function desktopColorFor(profile: Profile): keyof typeof DESKTOP_COLORS | "none" {
  const chosen = desktopConfigOf(profile)?.color;
  if (chosen === "none" || (chosen && Object.hasOwn(DESKTOP_COLORS, chosen))) return chosen;
  const names = Object.keys(DESKTOP_COLORS);
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(profile.slug, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return names[hash % names.length]!;
}

/** Accepts a palette color, "none" (original icon), or "auto" (default). */
export function validDesktopColor(value: string): boolean {
  return value === "auto" || value === "none" || Object.hasOwn(DESKTOP_COLORS, value);
}

export function desktopAliasName(profile: Profile, app: { name: string }): string {
  const config = desktopConfigOf(profile);
  return config?.aliasName && config.aliasName.trim().length > 0
    ? config.aliasName.trim()
    : `${app.name} ${profile.label}`.trim();
}

export function validAliasName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 80 &&
    !/[\\/:]/.test(name) &&
    !/[\u0000-\u001f\u007f]/.test(name) &&
    name !== "." &&
    name !== ".." &&
    !name.endsWith(".") &&
    name === name.trim()
  );
}

/**
 * Locate the installed Codex desktop app. CODEX_MULTI_DESKTOP_APP overrides
 * detection for custom install locations.
 */
export async function detectDesktopApp(): Promise<DesktopApp> {
  if (!desktopSupported() && !harnessMode()) {
    throw new Error("desktop app aliases are only supported on macOS");
  }
  const home = homedir();
  const explicit = process.env.CODEX_MULTI_DESKTOP_APP;
  const candidates = explicit
    ? [explicit]
    : [
        "/Applications/ChatGPT.app",
        "/Applications/Codex.app",
        join(home, "Applications", "ChatGPT.app"),
        join(home, "Applications", "Codex.app"),
      ];
  for (const path of candidates) {
    if (!isAppBundle(path)) continue;
    const values = await readPlistValues(join(path, "Contents", "Info.plist"));
    const name =
      values["CFBundleDisplayName"]?.trim() ||
      values["CFBundleName"]?.trim() ||
      basename(path).replace(/\.app$/i, "");
    return await appWithIcon(path, name, values);
  }
  const searched = candidates.join(", ");
  throw new Error(
    `Codex desktop app not found (looked at: ${searched}). ` +
      `Install the ChatGPT desktop app, or point CODEX_MULTI_DESKTOP_APP at its .app bundle.`,
  );
}

/** Attach the resolved icon, when the bundle carries a usable one. */
async function appWithIcon(
  path: string,
  name: string,
  values?: Record<string, string>,
): Promise<DesktopApp> {
  const app: DesktopApp = { path, name };
  const plist: Record<string, string> = values
    ?? (await readPlistValues(join(path, "Contents", "Info.plist")).catch(() => ({})));
  const iconPath = await resolveAppBundleIcon(path, plist["CFBundleIconFile"]);
  if (iconPath) app.iconPath = iconPath;
  return app;
}

function isAppBundle(path: string): boolean {
  try {
    return existsSync(join(path, "Contents", "MacOS"));
  } catch {
    return false;
  }
}

async function resolveAppBundleIcon(
  appPath: string,
  declared?: string,
): Promise<string | undefined> {
  const resources = join(appPath, "Contents", "Resources");
  const candidates: string[] = [];
  if (declared) {
    candidates.push(join(resources, declared.endsWith(".icns") ? declared : `${declared}.icns`));
  }
  candidates.push(join(resources, "app.icns"), join(resources, "electron.icns"));
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  try {
    for (const entry of await fs.readdir(resources)) {
      if (entry.endsWith(".icns")) return join(resources, entry);
    }
  } catch {
    // No readable icon at all.
  }
  return undefined;
}

/** Read key/string pairs from an XML plist. Uses plutil on macOS (handles binary plists). */
export async function readPlistValues(path: string): Promise<Record<string, string>> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/usr/bin/plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        path,
      ]);
      return stringValuesOf(JSON.parse(stdout));
    } catch {
      // Fall through to the XML parser for bundles plutil cannot read.
    }
  }
  const text = await fs.readFile(path, "utf8");
  const values: Record<string, string> = {};
  const pattern = /<key>([^<]+)<\/key>\s*<(?:string|integer)>([^<]*)<\/(?:string|integer)>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    values[unescapeXml(match[1]!)] = unescapeXml(match[2]!);
  }
  return values;
}

function stringValuesOf(parsed: unknown): Record<string, string> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") values[key] = value;
    else if (typeof value === "number") values[key] = String(value);
  }
  return values;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeSingleQuoted(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

/** A bundle belongs to this tool only when its plist carries the ownership marker. */
export async function isOwnedAliasBundle(path: string, slug?: string): Promise<boolean> {
  try {
    if ((await fs.lstat(path)).isSymbolicLink()) return false;
    const values = await readPlistValues(join(path, "Contents", "Info.plist"));
    const id = values["CFBundleIdentifier"] ?? "";
    const owner = values["CodexMultiSlug"];
    return Boolean(owner) && id === `${BUNDLE_ID_PREFIX}.${owner}` &&
      values["CodexMultiRoot"] === dataRoot() &&
      (slug === undefined || owner === slug);
  } catch {
    return false;
  }
}

async function aliasBundleSlug(path: string): Promise<string | undefined> {
  try {
    const values = await readPlistValues(join(path, "Contents", "Info.plist"));
    const id = values["CFBundleIdentifier"] ?? "";
    const slug = values["CodexMultiSlug"];
    if (!slug || id !== `${BUNDLE_ID_PREFIX}.${slug}` || values["CodexMultiRoot"] !== dataRoot()) return undefined;
    return slug;
  } catch {
    return undefined;
  }
}

export function desktopAliasPath(aliasName: string): string {
  return join(desktopAppsDir(), `${aliasName}.app`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function desktopManagerPath(): string {
  return join(dataRoot(), "runtime", "desktop-cli.mjs");
}

/** The complete bundled CLI remains usable when an npx cache is evicted. */
async function installDesktopManager(): Promise<void> {
  if (harnessMode()) return;
  const self = resolveSelfBinary();
  const modulePath = fileURLToPath(import.meta.url);
  const candidates = [
    ...(self.endsWith(".js") && basename(self) === "cli.js" ? [self] : []),
    ...(modulePath.endsWith(".js") ? [modulePath] : [join(dirname(modulePath), "..", "..", "dist", "cli.js")]),
  ];
  let content: Buffer | undefined;
  for (const path of candidates) {
    try {
      content = await fs.readFile(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!content) throw new Error("desktop launcher runtime is missing; build or reinstall codex-multi first");
  const destination = desktopManagerPath();
  await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o700 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function desktopScript(
  slug: string,
  app: { path: string },
  home: string,
  dataDir: string,
): string {
  return [
    "#!/bin/sh",
    `# codex-multi desktop launcher: ${slug}`,
    "unset CODEX_HOME CODEX_ELECTRON_USER_DATA_PATH CODEX_DESKTOP_RELAUNCH_OPEN_EVENTS OPENAI_API_KEY CODEX_ACCESS_TOKEN OPENAI_ORG_ID OPENAI_PROJECT_ID CODEX_MULTI_NO_AUTO_RUN CODEX_MULTI_NO_NATIVE_TOOLS",
    `CODEX_HOME='${escapeSingleQuoted(home)}'`,
    `DATA_DIR='${escapeSingleQuoted(dataDir)}'`,
    `APP_PATH='${escapeSingleQuoted(app.path)}'`,
    ...Object.entries({
      CODEX_MULTI_HOME: dataRoot(),
      CODEX_MULTI_PROFILES_DIR: profileHomesDir(),
      CODEX_MULTI_PROFILES_FILE: profilesFile(),
      CODEX_MULTI_BASE_HOME: baseCodexHome(),
      CODEX_MULTI_APPS_DIR: desktopAppsDir(),
    }).map(([key, value]) => `export ${key}='${escapeSingleQuoted(value)}'`),
    'export CODEX_MULTI_DESKTOP_APP="$APP_PATH"',
    // The manager refreshes config and serializes launch with profile mutation.
    `exec '${escapeSingleQuoted(process.execPath)}' '${escapeSingleQuoted(desktopManagerPath())}' desktop '${escapeSingleQuoted(slug)}'`,
    "",
  ].join("\n");
}

export function desktopInfoPlist(aliasName: string, slug: string, color: string): string {
  const keys: Array<[string, string | boolean]> = [
    ["CFBundleIdentifier", `${BUNDLE_ID_PREFIX}.${slug}`],
    ["CFBundleExecutable", ALIAS_EXECUTABLE],
    ["CFBundleName", aliasName],
    ["CFBundleDisplayName", aliasName],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", VERSION],
    ["CFBundleVersion", "1"],
    ["CFBundleIconFile", ALIAS_ICON],
    ["LSUIElement", true],
    ["NSHighResolutionCapable", true],
    ["CodexMultiSlug", slug],
    ["CodexMultiRoot", dataRoot()],
    // Recorded so `cpm sync` rebuilds bundles when the badge style or color
    // changes even though the launcher script itself is unchanged.
    ["CodexMultiIcon", `${ICON_REV}:${color}`],
  ];
  const body = keys
    .map(([key, value]) => {
      const escaped = typeof value === "boolean" ? `<${value}/>` : `<string>${escapeXml(value)}</string>`;
      return `  <key>${key}</key>\n  ${escaped}`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

async function runBestEffort(command: string, args: string[]): Promise<void> {
  if (process.platform !== "darwin") return;
  if (process.env.CODEX_MULTI_NO_NATIVE_TOOLS === "1") return;
  try {
    await execFileAsync(command, args);
  } catch {
    // Registration, quarantine, and signing are enhancements, not requirements.
  }
}

/**
 * Install (or refresh) the desktop alias bundle for one profile. Existing
 * aliases for the same slug under a different name are removed so label edits
 * do not leave stale copies behind.
 */
export async function installDesktopAlias(
  profile: Profile,
  app: DesktopApp,
): Promise<{ path: string; created: boolean }> {
  return await withFileLock(join(desktopAppsDir(), ".codex-multi-aliases.lock"), async () =>
    await installDesktopAliasLocked(profile, app));
}

async function installDesktopAliasLocked(
  profile: Profile,
  app: DesktopApp,
): Promise<{ path: string; created: boolean }> {
  const aliasName = desktopAliasName(profile, app);
  if (!validAliasName(aliasName)) {
    throw new Error(
      `invalid desktop alias name "${aliasName}": use 1-80 characters without path separators`,
    );
  }
  const dir = desktopAppsDir();
  const target = desktopAliasPath(aliasName);

  if (await pathExists(target) && !(await isOwnedAliasBundle(target, profile.slug))) {
    throw new Error(
      `${target} already exists and belongs to another app; ` +
        `choose a different label or pass --desktop-name (another profile's alias is also a conflict)`,
    );
  }
  await fs.mkdir(dir, { recursive: true });
  // The staging root intentionally has no .app suffix so parallel scans never
  // treat a half-built bundle as an installed alias.
  const stageRoot = await fs.mkdtemp(join(dir, ".codex-multi-stage-"));
  const stage = join(stageRoot, "alias.app");
  let preserveStage = false;
  try {
    await installDesktopManager();
    const executable = join(stage, "Contents", "MacOS", ALIAS_EXECUTABLE);
    await fs.mkdir(join(stage, "Contents", "MacOS"), { recursive: true, mode: 0o755 });
    await fs.mkdir(join(stage, "Contents", "Resources"), { recursive: true, mode: 0o755 });
    const script = desktopScript(
      profile.slug,
      app,
      profileHome(profile.slug),
      desktopUserDataDir(profile.slug),
    );
    await fs.writeFile(executable, script, { mode: 0o755 });
    await fs.chmod(executable, 0o755);
    await fs.writeFile(
      join(stage, "Contents", "Info.plist"),
      desktopInfoPlist(aliasName, profile.slug, desktopColorFor(profile)),
      { mode: 0o644 },
    );
    if (app.iconPath && existsSync(app.iconPath)) {
      await writeAliasIcon(join(stage, "Contents", "Resources", ALIAS_ICON), profile, app);
    }
    await runBestEffort("/usr/bin/xattr", ["-cr", stage]);
    await runBestEffort("/usr/bin/codesign", ["--force", "--sign", "-", stage]);

    // Recheck at commit, and keep the previous bundle until replacement works.
    const existed = await pathExists(target);
    if (existed && !(await isOwnedAliasBundle(target, profile.slug))) {
      throw new Error(`${target} already exists and belongs to another app or profile`);
    }
    const backup = join(stageRoot, "previous.app");
    if (existed) await fs.rename(target, backup);
    try {
      await fs.rename(stage, target);
    } catch (error) {
      if (existed) {
        try {
          if (await pathExists(target)) throw new Error(`${target} appeared during rollback`);
          await fs.rename(backup, target);
        } catch (restoreError) {
          preserveStage = true;
          throw new Error(`${(error as Error).message}; could not restore previous alias: ${(restoreError as Error).message}; original bundle preserved at ${backup}`, { cause: error });
        }
      }
      throw error;
    }
    await runBestEffort(LSREGISTER, ["-f", target]);
    for (const other of await ownedAliasesForSlug(profile.slug)) {
      if (other !== target) await removeBundle(other);
    }
    await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    return { path: target, created: !existed };
  } catch (error) {
    if (!preserveStage) await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Write the alias icon: the original app icon with a color badge (or the
 * unmodified original when no color applies or rendering is unavailable).
 */
async function writeAliasIcon(
  destination: string,
  profile: Profile,
  app: DesktopApp,
): Promise<void> {
  const color = desktopColorFor(profile);
  if (color !== "none") {
    const badged = await renderBadgedIcns(app.iconPath!, DESKTOP_COLORS[color]!);
    if (badged) {
      await fs.writeFile(destination, badged);
      return;
    }
  }
  await fs.copyFile(app.iconPath!, destination);
}

async function ownedAliasesForSlug(slug: string): Promise<string[]> {
  const dir = desktopAppsDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const owned: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
    const path = join(dir, entry.name);
    if ((await aliasBundleSlug(path)) === slug) owned.push(path);
  }
  return owned;
}

/** All alias bundles in the apps directory that carry this project's marker. */
export async function ownedAliasBundles(): Promise<Array<{ path: string; slug: string }>> {
  const dir = desktopAppsDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const owned: Array<{ path: string; slug: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
    const path = join(dir, entry.name);
    const slug = await aliasBundleSlug(path);
    if (slug !== undefined) owned.push({ path, slug });
  }
  return owned;
}

async function removeBundle(path: string): Promise<void> {
  if (!(await isOwnedAliasBundle(path))) throw new Error(`${path} is no longer an owned desktop alias; refusing to remove it`);
  await fs.rm(path, { recursive: true, force: true });
  await runBestEffort(LSREGISTER, ["-u", path]);
}

/** Remove every alias bundle owned by this tool for one profile. */
export async function removeDesktopAliases(slug: string): Promise<number> {
  return await withFileLock(join(desktopAppsDir(), ".codex-multi-aliases.lock"), async () =>
    await removeDesktopAliasesLocked(slug));
}

async function removeDesktopAliasesLocked(slug: string): Promise<number> {
  let removed = 0;
  for (const path of await ownedAliasesForSlug(slug)) {
    await removeBundle(path);
    removed++;
  }
  return removed;
}

/**
 * Reconcile alias bundles with the registry: refresh bundles whose baked
 * content changed and remove marked bundles whose profile no longer wants one.
 * Foreign .app bundles are never touched.
 */
export async function syncDesktopAliases(profiles: Profile[]): Promise<DesktopSyncResult> {
  const result: DesktopSyncResult = {
    created: 0,
    updated: 0,
    removed: 0,
    conflicts: [],
    dir: desktopAppsDir(),
  };
  if (!desktopSupported() && !harnessMode()) return result;

  await withFileLock(join(desktopAppsDir(), ".codex-multi-aliases.lock"), installDesktopManager);

  const enabledSlugs = new Set<string>();
  for (const snapshot of profiles) {
    await withFileLock(profileMutationLockPath(snapshot.slug), async () => {
      const profile = harnessMode() ? snapshot : await findRegistered(snapshot.slug);
      if (!profile) return;
      const config = desktopConfigOf(profile);
      if (!config?.enabled) return;
      enabledSlugs.add(profile.slug);
      const app = await resolveConfiguredApp(config);
      if (!app) {
        result.conflicts.push(
          `${profile.label}: desktop app not found at ${config.appPath}; install it or run "cpm edit ${profile.slug} --desktop" to refresh`,
        );
        return;
      }
      const aliasName = desktopAliasName(profile, app);
      if (!validAliasName(aliasName)) {
        result.conflicts.push(`${profile.label}: invalid desktop alias name "${aliasName}"`);
        return;
      }
      const target = desktopAliasPath(aliasName);
      try {
        if (await pathExists(target) && !(await isOwnedAliasBundle(target, profile.slug))) {
          result.conflicts.push(`${target} already exists and belongs to another app or profile`);
          return;
        }
        const iconExpected = app.iconPath !== undefined;
        const upToDate =
          (!iconExpected || existsSync(join(target, "Contents", "Resources", ALIAS_ICON))) &&
          (await filesEqual(
            join(target, "Contents", "Info.plist"),
            desktopInfoPlist(aliasName, profile.slug, desktopColorFor(profile)),
          )) &&
          (await filesEqual(
            join(target, "Contents", "MacOS", ALIAS_EXECUTABLE),
            desktopScript(
              profile.slug,
              app,
              profileHome(profile.slug),
              desktopUserDataDir(profile.slug),
            ),
          ));
        if (upToDate) return;
        const installed = await installDesktopAlias(profile, app);
        if (installed.created) result.created++;
        else result.updated++;
      } catch (error) {
        result.conflicts.push(`${profile.label}: ${(error as Error).message}`);
      }
    });
  }

  await withFileLock(join(desktopAppsDir(), ".codex-multi-aliases.lock"), async () => {
    const wanted = harnessMode() ? enabledSlugs : new Set((await loadRegistered()).filter(p => desktopConfigOf(p)?.enabled).map(p => p.slug));
    for (const owned of await ownedAliasBundles()) {
      if (wanted.has(owned.slug)) continue;
      try {
        await removeBundle(owned.path);
        result.removed++;
      } catch (error) {
        result.conflicts.push(`${owned.path}: could not remove alias: ${(error as Error).message}`);
      }
    }
  });
  return result;
}

async function resolveConfiguredApp(config: DesktopConfig): Promise<DesktopApp | undefined> {
  if (isAppBundle(config.appPath)) {
    return await appWithIcon(config.appPath, config.appName);
  }
  try {
    const detected = await detectDesktopApp();
    return { ...detected, name: config.appName || detected.name };
  } catch {
    return undefined;
  }
}

async function filesEqual(path: string, expected: string): Promise<boolean> {
  try {
    return (await fs.readFile(path, "utf8")) === expected;
  } catch {
    return false;
  }
}

/** Launch one profile's desktop instance directly (same command the alias runs). */
export async function launchDesktop(profile: Profile): Promise<void> {
  if (!desktopSupported()) {
    throw new Error("desktop app launch is only supported on macOS");
  }
  const config = desktopConfigOf(profile);
  const detected = config && isAppBundle(config.appPath)
    ? { path: config.appPath, name: config.appName }
    : await detectDesktopApp();
  const home = profileHome(profile.slug);
  const dataDir = desktopUserDataDir(profile.slug);
  await fs.mkdir(dataDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key === "CODEX_HOME" ||
      key === "CODEX_ELECTRON_USER_DATA_PATH" ||
      key === "CODEX_DESKTOP_RELAUNCH_OPEN_EVENTS" ||
      key === "CODEX_ACCESS_TOKEN" ||
      key === "OPENAI_API_KEY" ||
      key === "OPENAI_ORG_ID" ||
      key === "OPENAI_PROJECT_ID"
    ) {
      continue;
    }
    env[key] = value;
  }
  env.CODEX_HOME = home;

  await withFileLock(profileLifecycleLockPath(profile.slug), async () => {
    await execFileAsync("/usr/bin/open", [
      "-n",
      detected.path,
      "--env",
      `CODEX_HOME=${home}`,
      "--args",
      `--user-data-dir=${dataDir}`,
    ], { env });
    // Keep mutations serialized until the app process is visible to guards.
    await waitForDesktopStartup(profile.slug);
    await ensureCallbackRouterHandler();
  });
}
