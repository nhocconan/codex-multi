import { promises as fs } from "node:fs";
import { desktopConfigOf, removeDesktopAliases } from "../core/desktop.ts";
import { assertDesktopStopped } from "../core/desktop-runtime.ts";
import { buildProfileHome } from "../core/profile-home.ts";
import {
  profileHome,
  profileLifecycleLockPath,
  profileMutationLockPath,
} from "../core/paths.ts";
import {
  find,
  findRegistered,
  isSeparated,
  loadRegistered,
  recoverProfileRemovalLocked,
  rewrite,
  validLabel,
  validSlug,
  type Profile,
} from "../core/registry.ts";
import { withFileLocks } from "../core/lock.ts";
import { syncLaunchers } from "../core/wrappers.ts";
import { moveDesktopUserData, setDesktopEnabledLocked } from "./desktop.ts";
import { promptLine } from "../ui.ts";

export interface EditOptions {
  name?: string | undefined;
  slug?: string | undefined;
  desktop?: boolean | undefined;
  noDesktop?: boolean | undefined;
  desktopName?: string | undefined;
  desktopColor?: string | undefined;
}

export async function edit(slug: string, options: EditOptions): Promise<void> {
  const current = await find(slug);
  if (!current) throw new Error(`unknown profile: ${slug}`);
  if (options.noDesktop === true && options.desktop === true) {
    throw new Error("pass either --desktop or --no-desktop, not both");
  }
  if (options.noDesktop === true && (options.desktopName !== undefined || options.desktopColor !== undefined)) {
    throw new Error("--desktop-name/--desktop-color cannot be combined with --no-desktop");
  }

  const hasDesktopFlags =
    options.desktop !== undefined ||
    options.noDesktop !== undefined ||
    options.desktopName !== undefined ||
    options.desktopColor !== undefined;
  const label = options.name
    ?? (hasDesktopFlags ? current.label : await promptLine("Display name", current.label));
  let nextSlug = options.slug
    ?? (hasDesktopFlags ? current.slug : await promptLine("Command suffix (without codex-)", current.slug));
  nextSlug = nextSlug.replace(/^codex-/, "");
  if (!validLabel(label)) {
    throw new Error("display name must be non-empty and contain no control characters");
  }
  if (!validSlug(nextSlug)) {
    throw new Error(
      'suffix must use lowercase letters, numbers, and internal hyphens only; "multi" is reserved',
    );
  }
  await withFileLocks(
    [profileMutationLockPath(slug), profileMutationLockPath(nextSlug)],
    async () => {
      await withFileLocks(
        [profileLifecycleLockPath(slug), profileLifecycleLockPath(nextSlug)],
        async () => await editLocked(slug, label, nextSlug, options),
      );
    },
  );
}

async function editLocked(
  slug: string,
  label: string,
  nextSlug: string,
  options: EditOptions,
): Promise<void> {
  await recoverProfileRemovalLocked(slug);
  if (nextSlug !== slug) await recoverProfileRemovalLocked(nextSlug);
  const current = await findRegistered(slug);
  if (!current) throw new Error(`unknown profile: ${slug}`);
  const existingDesktop = desktopConfigOf(current);
  const desktopWasEnabled = existingDesktop?.enabled === true;
  const enable = options.desktop === true;
  const disable = options.noDesktop === true;
  const restylesDesktop =
    options.desktopName !== undefined || options.desktopColor !== undefined;
  if (restylesDesktop && !desktopWasEnabled && !enable) {
    throw new Error(`${current.label} has no desktop alias; pass --desktop to enable it first`);
  }
  const desktopEnabled = disable ? false : enable ? true : desktopWasEnabled;
  if (
    !enable &&
    label === current.label &&
    nextSlug === current.slug &&
    desktopEnabled === desktopWasEnabled &&
    (options.desktopName === undefined || options.desktopName === existingDesktop?.aliasName) &&
    (options.desktopColor === undefined ||
      options.desktopColor === (existingDesktop?.color ?? "auto"))
  ) {
    console.log("No changes.");
    return;
  }
  if (nextSlug !== current.slug && (await findRegistered(nextSlug))) {
    throw new Error(`profile ${nextSlug} already exists`);
  }

  const next: Profile = { ...current, slug: nextSlug, label };
  let moved = false;
  let desktopMoved = false;
  if (nextSlug !== current.slug) {
    await assertDesktopStopped(current.slug);
    await assertDesktopStopped(nextSlug);
    try {
      await fs.lstat(profileHome(nextSlug));
      throw new Error(
        `profile directory ${profileHome(nextSlug)} already exists; move or remove it explicitly before renaming`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(profileHome(current.slug), profileHome(nextSlug));
    moved = true;
  }
  try {
    if (moved) desktopMoved = await moveDesktopUserData(current.slug, nextSlug);
    await rewrite(current.slug, next);
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (desktopMoved) {
      await moveDesktopUserData(nextSlug, current.slug).catch((restoreError: unknown) => {
        rollbackErrors.push(`desktop data: ${(restoreError as Error).message}`);
      });
    }
    if (moved) {
      await fs.rename(profileHome(nextSlug), profileHome(current.slug)).catch((restoreError: unknown) => {
        rollbackErrors.push(`profile home: ${(restoreError as Error).message}`);
      });
    }
    if (rollbackErrors.length) {
      throw new Error(
        `${(error as Error).message}; additionally failed to restore ${rollbackErrors.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
  await buildProfileHome(nextSlug, isSeparated(next));
  const result = await syncLaunchers(await loadRegistered());
  for (const conflict of result.conflicts) {
    process.stderr.write(`warning: launcher already exists and was not replaced: ${conflict}\n`);
  }
  if (desktopWasEnabled && nextSlug !== current.slug) {
    await removeDesktopAliases(current.slug).catch(() => {});
  }
  if (desktopEnabled) {
    try {
      await setDesktopEnabledLocked(nextSlug, true, {
        ...(options.desktopName !== undefined ? { aliasName: options.desktopName } : {}),
        ...(options.desktopColor !== undefined ? { color: options.desktopColor } : {}),
      });
    } catch (error) {
      throw new Error(
        `profile details updated, but desktop alias could not be refreshed: ${(error as Error).message}. ` +
          `Run "cpm edit ${nextSlug} --desktop" after fixing it`,
        { cause: error },
      );
    }
  } else if (disable && desktopWasEnabled) {
    try {
      await setDesktopEnabledLocked(nextSlug, false);
    } catch (error) {
      throw new Error(
        `profile details updated, but desktop alias could not be removed: ${(error as Error).message}. ` +
          `Run "cpm edit ${nextSlug} --no-desktop" to retry`,
        { cause: error },
      );
    }
  }
  console.log(`Updated ${label}. Launch with: codex-${nextSlug}`);
}
