import { promises as fs } from "node:fs";
import { buildProfileHome } from "../core/profile-home.ts";
import {
  profileHome,
  profileLifecycleLockPath,
  profileMutationLockPath,
} from "../core/paths.ts";
import {
  find,
  findRegistered,
  loadRegistered,
  recoverProfileRemovalLocked,
  rewrite,
  validLabel,
  validSlug,
  type Profile,
} from "../core/registry.ts";
import { withFileLocks } from "../core/lock.ts";
import { syncLaunchers } from "../core/wrappers.ts";
import { promptLine } from "../ui.ts";

export interface EditOptions {
  name?: string | undefined;
  slug?: string | undefined;
}

export async function edit(slug: string, options: EditOptions): Promise<void> {
  const current = await find(slug);
  if (!current) throw new Error(`unknown profile: ${slug}`);

  const label = options.name ?? (await promptLine("Display name", current.label));
  let nextSlug =
    options.slug ?? (await promptLine("Command suffix (without codex-)", current.slug));
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
        async () => await editLocked(slug, label, nextSlug),
      );
    },
  );
}

async function editLocked(slug: string, label: string, nextSlug: string): Promise<void> {
  await recoverProfileRemovalLocked(slug);
  if (nextSlug !== slug) await recoverProfileRemovalLocked(nextSlug);
  const current = await findRegistered(slug);
  if (!current) throw new Error(`unknown profile: ${slug}`);
  if (label === current.label && nextSlug === current.slug) {
    console.log("No changes.");
    return;
  }
  if (nextSlug !== current.slug && (await findRegistered(nextSlug))) {
    throw new Error(`profile ${nextSlug} already exists`);
  }

  const next: Profile = { ...current, slug: nextSlug, label };
  let moved = false;
  if (nextSlug !== current.slug) {
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
    await rewrite(current.slug, next);
  } catch (error) {
    if (moved) await fs.rename(profileHome(nextSlug), profileHome(current.slug)).catch(() => {});
    throw error;
  }
  await buildProfileHome(nextSlug);
  const result = await syncLaunchers(await loadRegistered());
  for (const conflict of result.conflicts) {
    process.stderr.write(`warning: launcher already exists and was not replaced: ${conflict}\n`);
  }
  console.log(`Updated ${label}. Launch with: codex-${nextSlug}`);
}
