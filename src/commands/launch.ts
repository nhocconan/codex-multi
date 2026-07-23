import { launch as launchCodex } from "../core/launcher.ts";
import { findRegistered, recoverProfileRemovalLocked } from "../core/registry.ts";
import { profileMutationLockPath } from "../core/paths.ts";
import { withFileLock } from "../core/lock.ts";

export async function launch(slug: string, args: string[]): Promise<number> {
  return await withFileLock(profileMutationLockPath(slug), async () => {
    await recoverProfileRemovalLocked(slug);
    const profile = await findRegistered(slug);
    if (!profile) throw new Error(`unknown profile: ${slug}\nRun: cpm list`);
    return await launchCodex(profile, args[0] === "--" ? args.slice(1) : args);
  });
}
