import { findRegistered, recoverProfileRemovalLocked } from "../core/registry.ts";
import { login as runLogin, type LoginOptions } from "../core/login.ts";
import { profileMutationLockPath } from "../core/paths.ts";
import { withFileLock } from "../core/lock.ts";

export async function login(slug: string, options: LoginOptions): Promise<void> {
  await withFileLock(profileMutationLockPath(slug), async () => {
    await recoverProfileRemovalLocked(slug);
    const profile = await findRegistered(slug);
    if (!profile) throw new Error(`unknown profile: ${slug}`);
    process.stdout.write(
      `Sign in again for "${profile.label}". Your old login is restored if this fails.\n\n`,
    );
    await runLogin(profile, options);
    console.log(`Updated login for ${profile.label}.`);
  });
}
