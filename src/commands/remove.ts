import { promises as fs } from "node:fs";
import {
  profileHome,
  profileLifecycleLockPath,
  profileMutationLockPath,
} from "../core/paths.ts";
import {
  find,
  findRegistered,
  loadRegistered,
  remove as removeRegistry,
  recoverProfileRemovalLocked,
} from "../core/registry.ts";
import { withFileLock } from "../core/lock.ts";
import { removeLauncher, syncLaunchers } from "../core/wrappers.ts";
import { confirm } from "../ui.ts";

export async function remove(slug: string, yes = false): Promise<void> {
  const profile = await find(slug);
  if (!profile) throw new Error(`unknown profile: ${slug}`);
  if (!yes && !(await confirm(`Remove ${profile.label} and its isolated login?`))) {
    console.log("Kept.");
    return;
  }
  await withFileLock(profileMutationLockPath(slug), async () => {
    await withFileLock(profileLifecycleLockPath(slug), async () => {
      await recoverProfileRemovalLocked(slug);
      const current = await findRegistered(slug);
      if (!current) throw new Error(`unknown profile: ${slug}`);
      await removeLocked(current);
    });
  });
}

async function removeLocked(profile: import("../core/registry.ts").Profile): Promise<void> {
  const slug = profile.slug;
  const home = profileHome(slug);
  const tombstone = `${home}.cpm-removing-${process.pid}-${Date.now()}`;
  let moved = false;
  try {
    await fs.rename(home, tombstone);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await removeRegistry(slug);
  } catch (error) {
    if (moved) await restoreOrThrow(tombstone, home, error);
    throw error;
  }
  try {
    await removeLauncher(slug);
    if (moved) await fs.rm(tombstone, { recursive: true });
  } catch (error) {
    throw new Error(
      `profile was removed from the registry, but credential cleanup at ${tombstone} failed: ${(error as Error).message}. A later cpm command will retry it.`,
      { cause: error },
    );
  }
  try {
    await syncLaunchers(await loadRegistered());
  } catch (error) {
    process.stderr.write(
      `warning: profile was removed but launchers could not be synchronized: ${(error as Error).message}\n` +
        `Run "cpm sync" after fixing the launcher directory.\n`,
    );
  }
  console.log(`Removed ${profile.label}. Its profile auth cannot be recovered by this tool.`);
}

async function restoreOrThrow(from: string, to: string, original: unknown): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (restoreError) {
    throw new Error(
      `registry update failed: ${(original as Error).message}; profile restore also failed: ${(restoreError as Error).message}`,
      { cause: original },
    );
  }
}
