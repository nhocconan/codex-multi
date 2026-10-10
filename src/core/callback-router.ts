import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dataRoot, profilesFile } from "./paths.ts";
import { VERSION } from "../version.ts";
import { withFileLock } from "./lock.ts";

const exec = promisify(execFile);
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
interface RouterState { enabled: true; previousHandler: string; id: string; bundle: string }
const harness = () => process.env.CODEX_MULTI_NO_NATIVE_TOOLS === "1";
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function routerPaths(): { bundle: string; agent: string; state: string; id: string } {
  const hash = createHash("sha256").update(dataRoot()).digest("hex").slice(0, 12);
  const id = `io.github.nhocconan.codex-multi.callback-router.${hash}`;
  return {
    bundle: join(process.env.CODEX_MULTI_APPS_DIR || join(homedir(), "Applications"), "Codex Multi Callback Router.app"),
    agent: join(process.env.CODEX_MULTI_LAUNCH_AGENTS_DIR || join(homedir(), "Library", "LaunchAgents"), `${id}.plist`),
    state: join(dataRoot(), "callback-router", "config.json"), id,
  };
}
export function routerPlist(root: string, profiles: string, id: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${xml(id)}</string>
<key>CFBundleName</key><string>Codex Multi Callback Router</string>
<key>CFBundleExecutable</key><string>callback-router</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>${xml(VERSION)}</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/>
<key>NSAppleEventsUsageDescription</key><string>Send a browser approval to the Codex profile you choose.</string>
<key>CodexMultiRouter</key><string>1</string><key>CodexMultiRoot</key><string>${xml(root)}</string>
<key>CodexMultiProfilesFile</key><string>${xml(profiles)}</string>
<key>CodexMultiAppBundleIdentifier</key><string>com.openai.codex</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleTypeRole</key><string>Editor</string><key>CFBundleURLName</key><string>Codex approvals</string>
<key>CFBundleURLSchemes</key><array><string>codex</string></array></dict></array>
</dict></plist>\n`;
}
export function routerAgentPlist(binary: string, id: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>${xml(id)}</string><key>CodexMultiRoot</key><string>${xml(dataRoot())}</string>
<key>ProgramArguments</key><array><string>${xml(binary)}</string><string>--watch</string><string>${xml(id)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>\n`;
}
async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
async function state(): Promise<RouterState | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(routerPaths().state, "utf8")) as RouterState;
    const paths = routerPaths();
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.enabled !== true || value.id !== paths.id || value.bundle !== paths.bundle ||
      typeof value.previousHandler !== "string" || value.previousHandler.length > 255 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value.previousHandler)) throw new Error("invalid callback router state; repair it before changing the URL handler");
    return value;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
async function ownedBundle(): Promise<boolean> {
  const path = routerPaths().bundle;
  try {
    if (!(await fs.lstat(path)).isDirectory()) return false;
    // Avoid a dependency cycle with desktop.ts; markers are compared as escaped XML.
    const plist = await fs.readFile(join(path, "Contents", "Info.plist"), "utf8");
    return plist.includes(`<key>CodexMultiRouter</key><string>1</string>`) &&
      plist.includes(`<key>CodexMultiRoot</key><string>${xml(dataRoot())}</string>`) &&
      plist.includes(`<key>CFBundleIdentifier</key><string>${xml(routerPaths().id)}</string>`);
  } catch { return false; }
}
async function ownedAgent(): Promise<boolean> {
  const paths = routerPaths();
  try {
    if (!(await fs.lstat(paths.agent)).isFile()) return false;
    const plist = await fs.readFile(paths.agent, "utf8");
    return plist === routerAgentPlist(join(paths.bundle, "Contents", "MacOS", "callback-router"), paths.id);
  } catch { return false; }
}
async function native(file: string, args: string[]): Promise<string> {
  if (harness()) return "";
  const { stdout } = await exec(file, args, { maxBuffer: 1024 * 1024, timeout: file === "/usr/bin/open" ? 45_000 : 40_000 });
  return stdout.trim();
}
async function register(binary: string, id: string): Promise<void> {
  try { await native(binary, ["--register", id]); }
  catch (error) {
    // LaunchServices may need the helper's app identity, rather than a CLI child.
    // Do not retry a denied or timed-out macOS consent request.
    const bundle = dirname(dirname(dirname(binary)));
    if (!(error as Error).message.includes("handler-unchanged") || !bundle.endsWith(".app")) throw error;
    await native("/usr/bin/open", ["-W", "-n", bundle, "--args", "--register", id]);
    if (await native(binary, ["--handler"]) !== id) throw error;
  }
}
function domain(): string { return `gui/${process.getuid?.() ?? 0}`; }
async function compileHelper(destination: string): Promise<void> {
  if (harness()) { await fs.writeFile(destination, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); return; }
  const candidates = [fileURLToPath(new URL("./CallbackRouter.swift", import.meta.url)),
    fileURLToPath(new URL("../../native/macos/CallbackRouter.swift", import.meta.url))];
  const source = (await Promise.all(candidates.map(exists))).findIndex(Boolean);
  if (source < 0) throw new Error("callback router source is missing from this package");
  try { await native("/usr/bin/swiftc", [candidates[source]!, "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx12.0`, "-o", destination, "-framework", "AppKit", "-framework", "CoreServices"]); }
  catch { throw new Error("could not compile callback router; install Apple Command Line Tools with xcode-select --install, then retry"); }
}
async function bootout(): Promise<void> {
  if (!harness()) {
    try { await exec("/bin/launchctl", ["bootout", `${domain()}/${routerPaths().id}`]); }
    catch (error) {
      const message = (error as Error).message;
      if (!/Could not find service|No such process|No such file/i.test(message)) throw error;
    }
  }
}
export async function ensureCallbackRouterHandler(): Promise<void> {
  if (process.platform !== "darwin" && !harness()) return;
  await withFileLock(join(dataRoot(), "callback-router.lock"), ensureHandlerLocked);
}
async function ensureHandlerLocked(): Promise<void> {
  const config = await state();
  if (!config) return;
  if (!(await ownedBundle())) throw new Error("enabled callback router bundle is missing or foreign; run cpm callback-router disable to restore the previous handler");
  await register(join(config.bundle, "Contents", "MacOS", "callback-router"), config.id);
}
export async function callbackRouter(command: string): Promise<void> {
  if (!["enable", "disable", "status"].includes(command)) throw new Error("usage: cpm callback-router <enable|disable|status>");
  if (process.platform !== "darwin" && !harness()) throw new Error("callback routing is only supported on macOS");
  await withFileLock(join(dataRoot(), "callback-router.lock"), async () => {
    const paths = routerPaths();
    const current = await state();
    if (command === "status") {
      if (!current) console.log("Callback routing: off.");
      else {
        const active = harness() || (await ownedBundle() && await native(join(current.bundle, "Contents", "MacOS", "callback-router"), ["--handler"]) === current.id);
        console.log(active ? "Callback routing: enabled and active (choose a running profile for each browser approval)." : "Callback routing: enabled but inactive; run cpm callback-router enable and approve the macOS handler change.");
      }
      return;
    }
    if (await exists(paths.bundle) && !(await ownedBundle())) throw new Error(`${paths.bundle} belongs to another app or manager; refusing to change it`);
    if (await exists(paths.agent) && !(await ownedAgent())) throw new Error(`${paths.agent} belongs to another launch agent; refusing to change it`);
    const binary = join(paths.bundle, "Contents", "MacOS", "callback-router");
    if (command === "disable") {
      if (!current) { console.log("Callback routing: already off."); return; }
      await bootout();
      let restoreBinary = binary;
      let recovery: string | undefined;
      try {
        if (!(await ownedBundle())) {
          await fs.mkdir(dirname(paths.state), { recursive: true });
          recovery = await fs.mkdtemp(join(dirname(paths.state), "recovery-"));
          restoreBinary = join(recovery, "callback-router");
          await compileHelper(restoreBinary);
        }
        const handler = await native(restoreBinary, ["--handler"]);
        if (harness() || handler === current.id) await register(restoreBinary, current.previousHandler);
      } finally { if (recovery) await fs.rm(recovery, { recursive: true, force: true }); }
      if (await ownedAgent()) await fs.unlink(paths.agent);
      await native(LSREGISTER, ["-u", paths.bundle]);
      if (await ownedBundle()) await fs.rm(paths.bundle, { recursive: true, force: true });
      await fs.unlink(paths.state);
      console.log("Callback routing disabled; previous URL handler restored when still owned by this router.");
      return;
    }
    if (current) { await ensureHandlerLocked(); console.log("Callback routing: already enabled."); return; }
    // Unrecorded owned files are not adopted: an interrupted install must be inspected.
    if (await exists(paths.bundle) || await exists(paths.agent)) throw new Error("callback router files exist without state; inspect and remove only the owned leftovers before enabling");
    await fs.mkdir(dirname(paths.bundle), { recursive: true });
    const stageRoot = await fs.mkdtemp(join(dirname(paths.bundle), ".codex-multi-router-"));
    const stage = join(stageRoot, "router.app");
    const stageBinary = join(stage, "Contents", "MacOS", "callback-router");
    let previousHandler = "com.openai.codex";
    let installed = false;
    let registered = false;
    try {
      await fs.mkdir(dirname(stageBinary), { recursive: true });
      await fs.writeFile(join(stage, "Contents", "Info.plist"), routerPlist(dataRoot(), profilesFile(), paths.id));
      await compileHelper(stageBinary);
      if (!harness()) {
        await native("/usr/bin/codesign", ["--force", "--sign", "-", stage]);
        previousHandler = (await native(stageBinary, ["--handler"])) || previousHandler;
      }
      if (!/^[a-zA-Z0-9_.-]+$/.test(previousHandler)) throw new Error("invalid previous URL handler");
      if (await exists(paths.bundle)) throw new Error("callback router destination appeared during installation");
      await fs.rename(stage, paths.bundle); installed = true;
      await native(LSREGISTER, ["-f", paths.bundle]);
      registered = true; await register(binary, paths.id);
      await fs.mkdir(dirname(paths.agent), { recursive: true });
      await fs.writeFile(paths.agent, routerAgentPlist(binary, paths.id), { flag: "wx", mode: 0o600 });
      await native("/bin/launchctl", ["bootstrap", domain(), paths.agent]);
      await fs.mkdir(dirname(paths.state), { recursive: true, mode: 0o700 });
      await fs.writeFile(paths.state, JSON.stringify({ enabled: true, previousHandler, id: paths.id, bundle: paths.bundle }) + "\n", { flag: "wx", mode: 0o600 });
      console.log("Callback routing enabled. Choose the profile that started each browser approval; disable with cpm callback-router disable.");
    } catch (error) {
      await bootout();
      if (registered) {
        try { await register(binary, previousHandler); }
        catch {
          await fs.mkdir(dirname(paths.state), { recursive: true, mode: 0o700 });
          await fs.writeFile(paths.state, JSON.stringify({ enabled: true, previousHandler, id: paths.id, bundle: paths.bundle }) + "\n", { flag: "wx", mode: 0o600 });
          throw new Error("callback router setup failed and its URL handler could not be restored; preserved recovery state and helper. Run cpm callback-router disable to retry", { cause: error });
        }
      }
      if (await ownedAgent()) await fs.unlink(paths.agent);
      if (installed && await ownedBundle()) await fs.rm(paths.bundle, { recursive: true, force: true });
      throw error;
    } finally { await fs.rm(stageRoot, { recursive: true, force: true }); }
  });
}
