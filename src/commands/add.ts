import { promises as fs } from "node:fs";
import {
  append,
  findRegistered,
  loadRegistered,
  recoverProfileRemovalLocked,
  slugify,
  validLabel,
  validSlug,
  type Profile,
} from "../core/registry.ts";
import { isOnPath, profileHome, profileMutationLockPath } from "../core/paths.ts";
import { buildProfileHome } from "../core/profile-home.ts";
import { copyCurrentAuth, inspectAuth } from "../core/auth.ts";
import { withFileLock } from "../core/lock.ts";
import { login, type LoginOptions } from "../core/login.ts";
import { syncLaunchers } from "../core/wrappers.ts";
import { promptLine } from "../ui.ts";

export interface AddOptions extends LoginOptions {
  name?: string | undefined;
  slug?: string | undefined;
  importCurrent?: boolean | undefined;
}

export async function add(options: AddOptions = {}): Promise<void> {
  const label = options.name ?? (await promptLine("Profile display name"));
  if (!validLabel(label)) {
    throw new Error("display name must be non-empty and contain no control characters");
  }
  let slug =
    options.slug ??
    (await promptLine("Command suffix (without codex-)", slugify(label)));
  slug = slug.replace(/^codex-/, "");
  if (!validSlug(slug)) {
    throw new Error("suffix must use lowercase letters, numbers, and internal hyphens only");
  }
  await withFileLock(profileMutationLockPath(slug), async () => {
    await addLocked(label, slug, options);
  });
}

async function addLocked(label: string, slug: string, options: AddOptions): Promise<void> {
  await recoverProfileRemovalLocked(slug);
  if (await findRegistered(slug)) throw new Error(`profile ${slug} already exists`);
  try {
    await fs.lstat(profileHome(slug));
    throw new Error(
      `profile directory ${profileHome(slug)} already exists; move or remove it explicitly before adding this profile`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const profile: Profile = { slug, label, createdAt: new Date().toISOString() };
  await buildProfileHome(slug);
  let committed = false;
  try {
    if (options.importCurrent) {
      await copyCurrentAuth(slug);
    } else {
      process.stdout.write(`\nSign in to the Codex account for "${label}".\n\n`);
      await login(profile, options);
    }
    const status = await inspectAuth(slug);
    if (!status.ok) throw new Error(status.problem ?? "profile login is invalid");
    await append(profile);
    committed = true;
    try {
      const result = await syncLaunchers(await loadRegistered());
      printConflicts(result.conflicts);
      if (!isOnPath(result.dir)) {
        process.stderr.write(
          `\n${result.dir} is not on PATH yet. Add this to your shell profile:\n` +
            `  export PATH="${result.dir}:$PATH"\n`,
        );
      }
    } catch (error) {
      process.stderr.write(
        `warning: profile was saved but its launcher could not be created: ${(error as Error).message}\n` +
          `Run "cpm sync" after fixing the launcher directory.\n`,
      );
    }
    console.log(`\nAdded ${label}. Launch it with: codex-${slug}`);
  } catch (error) {
    if (!committed) await fs.rm(profileHome(slug), { recursive: true, force: true });
    throw error;
  }
}

function printConflicts(conflicts: string[]): void {
  for (const path of conflicts) {
    process.stderr.write(`warning: launcher already exists and was not replaced: ${path}\n`);
  }
}
