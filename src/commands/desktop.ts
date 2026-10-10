import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_COLORS,
  desktopAliasName,
  desktopAppsDir,
  desktopColorFor,
  desktopConfigOf,
  desktopSupported,
  desktopUserDataDir,
  detectDesktopApp,
  installDesktopAlias,
  launchDesktop,
  removeDesktopAliases,
  ownedAliasBundles,
  validDesktopColor,
} from "../core/desktop.ts";
import { buildProfileHome } from "../core/profile-home.ts";
import { inspectAuth } from "../core/auth.ts";
import { profileMutationLockPath } from "../core/paths.ts";
import { findRegistered, isSeparated, recoverProfileRemovalLocked, rewrite, type Profile } from "../core/registry.ts";
import { withFileLock } from "../core/lock.ts";

export interface DesktopOptions {
  aliasName?: string | undefined;
  color?: string | undefined;
}

/**
 * Enable or disable a profile's desktop app alias. Enabling installs (or
 * refreshes) the alias bundle first and only then records it in the registry,
 * so a failed install never leaves the registry pointing at nothing.
 */
export async function setDesktopEnabled(
  slug: string,
  enabled: boolean,
  options: DesktopOptions = {},
): Promise<void> {
  await withFileLock(profileMutationLockPath(slug), async () => {
    await setDesktopEnabledLocked(slug, enabled, options);
  });
}

/** Same as setDesktopEnabled, for callers already holding the mutation lock. */
export async function setDesktopEnabledLocked(
  slug: string,
  enabled: boolean,
  options: DesktopOptions = {},
): Promise<void> {
  if (enabled && !desktopSupported() && process.env.CODEX_MULTI_NO_NATIVE_TOOLS !== "1") {
    throw new Error("desktop app aliases are only supported on macOS");
  }
  const current = await findRegistered(slug);
  if (!current) throw new Error(`unknown profile: ${slug}`);
  const existing = desktopConfigOf(current);
  const rawDesktop = current.desktop && typeof current.desktop === "object" && !Array.isArray(current.desktop)
    ? current.desktop as Record<string, unknown>
    : {};

  if (!enabled) {
    if (!existing?.enabled) {
      console.log(`Desktop alias already off for ${current.label}.`);
      return;
    }
    let removed = 0;
    const next: Profile = { ...current, desktop: { ...rawDesktop, enabled: false } };
    await withAliasRollback(slug, async () => {
      removed = await removeDesktopAliases(slug);
      await rewrite(slug, next);
    });
    console.log(
      removed > 0
        ? `Removed ${removed} desktop alias bundle(s) for ${current.label}.`
        : `Desktop alias disabled for ${current.label}.`,
    );
    return;
  }

  const app = await detectDesktopApp();
  const aliasName = options.aliasName?.trim();
  const color = options.color?.trim();
  if (color !== undefined && color !== "" && !validDesktopColor(color)) {
    throw new Error(
      `unknown desktop color "${color}"; choose one of: auto, none, ${Object.keys(DESKTOP_COLORS).join(", ")}`,
    );
  }
  const desktop: Record<string, unknown> = {
    ...rawDesktop,
    enabled: true,
    appPath: app.path,
    appName: app.name,
  };
  if (aliasName) desktop.aliasName = aliasName;
  else if (options.aliasName !== undefined) delete desktop.aliasName;
  if (color && color !== "auto") desktop.color = color;
  else if (color === "auto" || color === "") delete desktop.color;
  const next: Profile = { ...current, desktop };
  await withAliasRollback(slug, async () => {
    await installDesktopAlias(next, app);
    await rewrite(slug, next);
  });
  console.log(
    `Desktop alias ready: ${desktopAliasName(next, app)} (icon badge: ${desktopColorFor(next)}) — Spotlight it or run: cpm desktop ${slug}`,
  );
}

/** Preserve exact owned bundles, including the old icon/app, until registry commit. */
async function withAliasRollback(slug: string, action: () => Promise<void>): Promise<void> {
  await fs.mkdir(desktopAppsDir(), { recursive: true });
  const backup = await fs.mkdtemp(join(desktopAppsDir(), ".codex-multi-rollback-"));
  const aliasLock = join(desktopAppsDir(), ".codex-multi-aliases.lock");
  let keepBackup = false;
  try {
    const aliases = await withFileLock(aliasLock, async () => {
      const aliases = (await ownedAliasBundles()).filter((alias) => alias.slug === slug);
      for (const [index, alias] of aliases.entries()) {
        await fs.cp(alias.path, join(backup, String(index)), { recursive: true });
      }
      return aliases;
    });
    try {
      await action();
    } catch (error) {
      try {
        await removeDesktopAliases(slug);
        await withFileLock(aliasLock, async () => {
          for (const [index, alias] of aliases.entries()) {
            // Never overwrite a bundle that appeared after the failed update.
            try {
              await fs.lstat(alias.path);
              throw new Error(`${alias.path} already exists; refusing to overwrite it during rollback`);
            } catch (collisionError) {
              if ((collisionError as NodeJS.ErrnoException).code !== "ENOENT") throw collisionError;
            }
            await fs.cp(join(backup, String(index)), alias.path, {
              recursive: true,
              force: false,
              errorOnExist: true,
            });
          }
        });
      } catch (restoreError) {
        keepBackup = true;
        throw new Error(
          `${(error as Error).message}; additionally failed to restore desktop aliases: ${(restoreError as Error).message}; preserved original bundles at ${backup}`,
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    if (!keepBackup) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

/** `cpm desktop <slug>`: open the profile's isolated desktop app instance. */
export async function desktop(slug: string): Promise<void> {
  await withFileLock(profileMutationLockPath(slug), async () => {
    await recoverProfileRemovalLocked(slug);
    const profile = await findRegistered(slug);
    if (!profile) throw new Error(`unknown profile: ${slug}\nRun: cpm list`);
    const auth = await inspectAuth(slug);
    if (!auth.ok) {
      process.stderr.write(
        `warning: ${profile.label} is not logged in; the desktop app will show its own sign-in.\n`,
      );
    }
    await buildProfileHome(slug, isSeparated(profile));
    await launchDesktop(profile);
    console.log(`Opening ${profile.label} in the Codex desktop app...`);
  });
}

/** Move a profile's desktop data directory after a slug rename. */
export async function moveDesktopUserData(fromSlug: string, toSlug: string): Promise<boolean> {
  const source = desktopUserDataDir(fromSlug);
  const destination = desktopUserDataDir(toSlug);
  try {
    await fs.lstat(destination);
    throw new Error(
      `desktop data directory ${destination} already exists; move or remove it explicitly before renaming`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fs.rename(source, destination);
  return true;
}
