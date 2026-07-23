import { add } from "./commands/add.ts";
import { doctor } from "./commands/doctor.ts";
import { launch } from "./commands/launch.ts";
import { list } from "./commands/list.ts";
import { sync } from "./commands/sync.ts";
import { command, load } from "./core/registry.ts";
import { select } from "./ui.ts";

export async function run(): Promise<number> {
  const profiles = await load();
  const actions = [
    ...profiles.map((profile) => `Launch ${profile.label}  (${command(profile)})`),
    "Add a new profile",
    "Import current Codex login",
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
  else if (action === 2) await list();
  else if (action === 3) return await doctor();
  else if (action === 4) await sync();
  return 0;
}
