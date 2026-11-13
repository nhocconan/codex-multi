import { promises as fs } from "node:fs";
import spawn from "cross-spawn";
import { inspectAuth, recoverAuthBackup } from "./auth.ts";
import { withFileLock } from "./lock.ts";
import { buildProfileHome } from "./profile-home.ts";
import { profileHome, profileLifecycleLockPath, resolveCodexBinary } from "./paths.ts";
import { isSeparated, type Profile } from "./registry.ts";
import { loginLocked } from "./login.ts";
import { select } from "../ui.ts";
import { buildProfileEnv } from "./environment.ts";
import { assertFileCredentialStore, withFileCredentialStore } from "./config-overrides.ts";
import { assertDesktopStopped } from "./desktop-runtime.ts";

export function buildLaunchEnv(profile: Profile, home: string): NodeJS.ProcessEnv {
  const env = buildProfileEnv(home);
  env.CODEX_MULTI_SLUG = profile.slug;
  env.CODEX_MULTI_LABEL = profile.label;
  return env;
}

export async function launch(profile: Profile, args: string[]): Promise<number> {
  assertFileCredentialStore(args);
  const invocation = identifyInvocation(args);
  return await withFileLock(profileLifecycleLockPath(profile.slug), async () => {
    const home = profileHome(profile.slug);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const commandArgs = args.slice(invocation.index + 1);
    const readOnly = invocation.readOnly ||
      (["login", "logout", "app"].includes(invocation.command ?? "") && hasHelp(commandArgs)) ||
      (invocation.command === "login" && ["status", "help"].includes(firstCommandArgument(commandArgs) ?? ""));
    if (readOnly) {
      await buildProfileHome(profile.slug, isSeparated(profile));
      return await runCodex(profile, home, args);
    }
    if (invocation.command === "app" && commandArgs.length === 1 && commandArgs[0] === "help") {
      await buildProfileHome(profile.slug, isSeparated(profile));
      return await runCodex(profile, home, [...args.slice(0, invocation.index + 1), "--help"]);
    }
    if (invocation.command === "app") {
      throw new Error(`Use cpm desktop ${profile.slug} to open this profile with isolated desktop data; native codex app cannot guarantee account isolation.`);
    }
    if (invocation.command === "login") {
      await loginLocked(profile, {}, commandArgs, args.slice(0, invocation.index));
      return 0;
    }
    if (invocation.command === "logout") {
      await assertDesktopStopped(profile.slug);
      await recoverAuthBackup(profile.slug);
      await buildProfileHome(profile.slug, isSeparated(profile));
      return await runCodex(profile, home, args);
    }
    await recoverAuthBackup(profile.slug, async () => await assertDesktopStopped(profile.slug));
    const auth = await inspectAuth(profile.slug);
    if (!auth.ok) {
      const guidance = `${profile.label} is not logged in (${auth.problem ?? "invalid auth"}).\n` +
        `Sign in: codex-${profile.slug} login --device-auth\n` +
        `Or run: npx --yes --package=codex-multi@latest codex-multi login ${profile.slug} --device-auth`;
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        throw new Error(guidance);
      }
      process.stderr.write(`${guidance}\n\n`);
      const choice = await select([
        "Sign in with a device code", "Sign in with a browser", "Cancel",
      ], `Sign in to ${profile.label}`);
      if (!choice.ok || choice.index === 2) return 0;
      await loginLocked(profile, { deviceAuth: choice.index === 0 });
    }
    await buildProfileHome(profile.slug, isSeparated(profile));
    return await runCodex(profile, home, args);
  });
}

async function runCodex(profile: Profile, home: string, args: string[]): Promise<number> {
  const binary = resolveCodexBinary();
  process.stderr.write(`Starting Codex profile: ${profile.label} (${profile.slug})\n`);

  const child = spawn(binary, withFileCredentialStore(args), {
    stdio: "inherit",
    env: buildLaunchEnv(profile, home),
    windowsHide: false,
  });
  const relay = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", relay);
  process.on("SIGTERM", relay);
  if (process.platform !== "win32") process.on("SIGHUP", relay);

  return await new Promise<number>((resolve, reject) => {
    child.once("error", (error) => {
      cleanup();
      reject(new Error(`could not start Codex (${binary}): ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal && process.platform !== "win32") {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
    function cleanup(): void {
      process.off("SIGINT", relay);
      process.off("SIGTERM", relay);
      if (process.platform !== "win32") process.off("SIGHUP", relay);
    }
  });
}

const ROOT_VALUE_FLAGS = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
  "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile",
  "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);
const ROOT_SWITCHES = new Set([
  "--strict-config", "--oss", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust", "--worktree", "--search", "--no-alt-screen", "--no-daemon",
  "--full-auto", "--yolo",
]);

function identifyInvocation(args: string[]): { command?: string; index: number; readOnly: boolean } {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (["--help", "-h", "--version", "-V"].includes(arg)) return { index, readOnly: true };
    if (!arg.startsWith("-") || arg === "-") return { command: arg, index, readOnly: arg === "help" };
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const attachedShort = !arg.startsWith("--") && arg.length > 2 && ROOT_VALUE_FLAGS.has(arg.slice(0, 2));
    const option = attachedShort ? arg.slice(0, 2) : flag;
    if (ROOT_VALUE_FLAGS.has(option)) {
      if (equals < 0 && !attachedShort) index++;
      if ((option === "-i" || option === "--image") && equals < 0 && !attachedShort) {
        while (index + 1 < args.length && !args[index + 1]!.startsWith("-")) index++;
      }
    } else if (!ROOT_SWITCHES.has(arg)) {
      throw new Error("Unsupported Codex global option; place supported global options before the command.");
    }
  }
  return { index: -1, readOnly: false };
}

function hasHelp(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return false;
    if (["--help", "-h"].includes(arg)) return true;
    if (ROOT_VALUE_FLAGS.has(arg) || arg === "--download-url") index++;
  }
  return false;
}

function firstCommandArgument(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return undefined;
    if (!arg.startsWith("-")) return arg;
    if (ROOT_VALUE_FLAGS.has(arg)) index++;
  }
  return undefined;
}
