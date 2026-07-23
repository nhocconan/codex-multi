import { promises as fs } from "node:fs";
import spawn from "cross-spawn";
import { authBackupPath, authPath, inspectAuth, recoverAuthBackup } from "./auth.ts";
import { withFileLock } from "./lock.ts";
import { buildProfileHome } from "./profile-home.ts";
import { profileHome, profileLifecycleLockPath, resolveCodexBinary } from "./paths.ts";
import type { Profile } from "./registry.ts";

export interface LoginOptions {
  deviceAuth?: boolean | undefined;
  apiKeyEnv?: string | undefined;
  accessTokenEnv?: string | undefined;
}

export async function login(profile: Profile, options: LoginOptions = {}): Promise<void> {
  if (options.apiKeyEnv && options.accessTokenEnv) {
    throw new Error("--api-key-env and --access-token-env cannot be used together");
  }
  const home = profileHome(profile.slug);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await withFileLock(profileLifecycleLockPath(profile.slug), async () => {
    await recoverAuthBackup(profile.slug);
    await loginLocked(profile, options);
  });
}

async function loginLocked(profile: Profile, options: LoginOptions): Promise<void> {
  const home = await buildProfileHome(profile.slug);
  const auth = authPath(profile.slug);
  const backup = authBackupPath(profile.slug);
  let hadPrevious = false;
  try {
    await fs.rename(auth, backup);
    hadPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    const args = ["login"];
    let secret: string | undefined;
    if (options.deviceAuth) args.push("--device-auth");
    if (options.apiKeyEnv) {
      secret = requiredSecret(options.apiKeyEnv);
      args.push("--with-api-key");
    }
    if (options.accessTokenEnv) {
      secret = requiredSecret(options.accessTokenEnv);
      args.push("--with-access-token");
    }
    const code = await runLoginProcess(resolveCodexBinary(), args, loginEnv(home), secret);
    if (code !== 0) throw new Error(`codex login exited with status ${code}`);
    const status = await inspectAuth(profile.slug);
    if (!status.ok) {
      throw new Error(`codex login completed but ${status.problem ?? "auth.json is invalid"}`);
    }
    if (hadPrevious) await fs.unlink(backup);
  } catch (error) {
    await fs.unlink(auth).catch(() => {});
    if (hadPrevious) {
      try {
        await fs.rename(backup, auth);
      } catch (restoreError) {
        throw new Error(
          `${(error as Error).message}; additionally failed to restore the previous login: ${(restoreError as Error).message}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function requiredSecret(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid environment variable name: ${name}`);
  }
  const value = process.env[name];
  if (!value) throw new Error(`environment variable ${name} is empty or missing`);
  return value;
}

function loginEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  return env;
}

async function runLoginProcess(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  secret?: string,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: secret === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
      env,
      windowsHide: false,
    });
    const relay = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    if (process.platform !== "win32") signals.push("SIGHUP");
    for (const signal of signals) process.on(signal, relay);
    const cleanup = (): void => {
      for (const signal of signals) process.off(signal, relay);
    };
    child.once("error", (error) => {
      cleanup();
      reject(new Error(`could not start Codex (${binary}): ${error.message}`));
    });
    child.once("exit", (code) => {
      cleanup();
      resolve(code ?? 1);
    });
    if (secret !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(`${secret}\n`);
    }
  });
}
