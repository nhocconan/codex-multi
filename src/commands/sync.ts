import { desktopSupported, syncDesktopAliases } from "../core/desktop.ts";
import { buildProfileHome } from "../core/profile-home.ts";
import { isOnPath, profileMutationLockPath } from "../core/paths.ts";
import { findRegistered, isSeparated, load } from "../core/registry.ts";
import { withFileLock } from "../core/lock.ts";
import { syncLaunchers } from "../core/wrappers.ts";

export async function sync(): Promise<void> {
  const profiles = await load();
  for (const profile of profiles) {
    await withFileLock(profileMutationLockPath(profile.slug), async () => {
      const current = await findRegistered(profile.slug);
      if (current) await buildProfileHome(current.slug, isSeparated(current));
    });
  }
  const result = await syncLaunchers(profiles);
  console.log(
    `Synced ${profiles.length} profile(s): ${result.created} launcher(s) created, ${result.updated} updated, ${result.removed} removed.`,
  );
  console.log(`Launcher directory: ${result.dir}`);
  if (!isOnPath(result.dir)) {
    process.stderr.write(
      `warning: launcher directory is not on PATH. Add:\n  export PATH="${result.dir}:$PATH"\n`,
    );
  }
  for (const conflict of result.conflicts) {
    process.stderr.write(`warning: launcher already exists and was not replaced: ${conflict}\n`);
  }
  if (desktopSupported()) {
    const desktop = await syncDesktopAliases(profiles);
    console.log(
      `Desktop aliases: ${desktop.created} created, ${desktop.updated} updated, ${desktop.removed} removed (${desktop.dir}).`,
    );
    for (const conflict of desktop.conflicts) {
      process.stderr.write(`warning: desktop alias not synced: ${conflict}\n`);
    }
  }
}
