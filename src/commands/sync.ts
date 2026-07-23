import { buildProfileHome } from "../core/profile-home.ts";
import { isOnPath } from "../core/paths.ts";
import { load } from "../core/registry.ts";
import { syncLaunchers } from "../core/wrappers.ts";

export async function sync(): Promise<void> {
  const profiles = await load();
  for (const profile of profiles) await buildProfileHome(profile.slug);
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
}
