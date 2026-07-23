import { promises as fs } from "node:fs";
import spawn from "cross-spawn";
import { inspectAuth, recoverAuthBackup } from "./auth.ts";
import { withFileLock } from "./lock.ts";
import { buildProfileHome } from "./profile-home.ts";
import { profileHome, profileLifecycleLockPath, resolveCodexBinary } from "./paths.ts";
import type { Profile } from "./registry.ts";

const SCRUBBED_AUTH_VARS = new Set([
  "CODEX_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
]);

export function buildLaunchEnv(profile: Profile, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SCRUBBED_AUTH_VARS.has(key) || key === "CODEX_HOME") continue;
    env[key] = value;
  }
  env.CODEX_HOME = home;
  env.CODEX_MULTI_SLUG = profile.slug;
  env.CODEX_MULTI_LABEL = profile.label;
  return env;
}

export async function launch(profile: Profile, args: string[]): Promise<number> {
  return await withFileLock(profileLifecycleLockPath(profile.slug), async () => {
    const home = profileHome(profile.slug);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await recoverAuthBackup(profile.slug);
    const auth = await inspectAuth(profile.slug);
    if (!auth.ok) {
      throw new Error(
        `${profile.label} is not logged in (${auth.problem ?? "invalid auth"}). Run: cpm login ${profile.slug}`,
      );
    }
    await buildProfileHome(profile.slug);
    return await runCodex(profile, home, args);
  });
}

async function runCodex(profile: Profile, home: string, args: string[]): Promise<number> {
  const binary = resolveCodexBinary();
  process.stderr.write(`Starting Codex profile: ${profile.label} (${profile.slug})\n`);

  const child = spawn(binary, args, {
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
