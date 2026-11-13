import { promises as fs } from "node:fs";
import spawn from "cross-spawn";
import { authBackupPath, authPath, inspectAuth, recoverAuthBackup } from "./auth.ts";
import { withFileLock } from "./lock.ts";
import { assertDesktopStopped } from "./desktop-runtime.ts";
import { buildProfileHome } from "./profile-home.ts";
import { profileHome, profileLifecycleLockPath, resolveCodexBinary } from "./paths.ts";
import { isSeparated, type Profile } from "./registry.ts";
import { buildProfileEnv } from "./environment.ts";
import { assertFileCredentialStore, withFileCredentialStore } from "./config-overrides.ts";

export interface LoginOptions {
  deviceAuth?: boolean | undefined;
  apiKeyEnv?: string | undefined;
  accessTokenEnv?: string | undefined;
}

export async function login(profile: Profile, options: LoginOptions = {}): Promise<void> {
  validateLoginOptions(options);
  const home = profileHome(profile.slug);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await withFileLock(profileLifecycleLockPath(profile.slug), async () => {
    await loginLocked(profile, options);
  });
}

/** Caller must hold the profile lifecycle lock throughout login and rollback. */
export async function loginLocked(
  profile: Profile,
  options: LoginOptions = {},
  codexArgs: string[] = [],
  prefixArgs: string[] = [],
): Promise<void> {
  validateLoginOptions(options);
  assertFileCredentialStore([...prefixArgs, ...codexArgs]);
  const secretName = options.apiKeyEnv ?? options.accessTokenEnv;
  const secret = secretName === undefined ? undefined : requiredSecret(secretName);
  await assertDesktopStopped(profile.slug);
  await recoverAuthBackup(profile.slug);
  const home = await buildProfileHome(profile.slug, isSeparated(profile));
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
    const args = [...prefixArgs, "login", ...codexArgs];
    if (options.deviceAuth) args.push("--device-auth");
    if (options.apiKeyEnv) {
      args.push("--with-api-key");
    }
    if (options.accessTokenEnv) {
      args.push("--with-access-token");
    }
    const env = buildProfileEnv(home, secretName === undefined ? [] : [secretName]);
    const code = await runLoginProcess(resolveCodexBinary(), args, env, secret);
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

function validateLoginOptions(options: LoginOptions): void {
  if ([options.deviceAuth, options.apiKeyEnv, options.accessTokenEnv].filter(Boolean).length > 1) {
    throw new Error("--device-auth, --api-key-env and --access-token-env cannot be used together");
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

async function runLoginProcess(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  secret?: string,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(binary, withFileCredentialStore(args), {
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
