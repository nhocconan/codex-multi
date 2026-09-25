import { add } from "./commands/add.ts";
import { doctor } from "./commands/doctor.ts";
import { edit } from "./commands/edit.ts";
import { launch } from "./commands/launch.ts";
import { list } from "./commands/list.ts";
import { login } from "./commands/login.ts";
import { remove } from "./commands/remove.ts";
import { sync } from "./commands/sync.ts";
import { command, load } from "./core/registry.ts";
import { select } from "./ui.ts";

export async function run(): Promise<number> {
  const profiles = await load();
  const actions = [
    ...profiles.map((profile) => `Launch ${profile.label}  (${command(profile)})`),
    "Add a new profile",
    "Import current Codex login",
    "Manage profiles",
    "List profiles",
    "Doctor",
    "Sync launchers",
    "Quit",
  ];
  const choice = await select(actions, "Codex Multi");
  if (!choice.ok) return 0;
  if (choice.index < profiles.length) return await launch(profiles[choice.index]!.slug, []);
  const action = choice.index - profiles.length;
  if (action === 0) await add();
  else if (action === 1) await add({ importCurrent: true });
  else if (action === 2) await manageProfiles();
  else if (action === 3) await list();
  else if (action === 4) return await doctor();
  else if (action === 5) await sync();
  return 0;
}

async function manageProfiles(): Promise<void> {
  while (true) {
    const profiles = await load();
    if (profiles.length === 0) {
      console.log("No profiles configured. Run: cpm add");
      return;
    }
    const selected = await select(
      [...profiles.map((profile) => `${profile.label}  (${command(profile)})`), "Back"],
      "Manage profiles",
    );
    if (!selected.ok || selected.index === profiles.length) return;
    const profile = profiles[selected.index]!;
    const action = await select(
      ["Sign in with another account", "Edit name or launcher", "Remove profile", "Back"],
      `${profile.label} (${command(profile)})`,
    );
    if (!action.ok || action.index === 3) continue;
    if (action.index === 0) await login(profile.slug, {});
    else if (action.index === 1) await edit(profile.slug, {});
    else if (action.index === 2) await remove(profile.slug);
  }
}
