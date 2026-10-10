import { add } from "./commands/add.ts";
import { desktop as desktopCommand, setDesktopEnabled } from "./commands/desktop.ts";
import { desktopAliasName, desktopConfigOf, detectDesktopApp } from "./core/desktop.ts";
import { doctor } from "./commands/doctor.ts";
import { edit } from "./commands/edit.ts";
import { launch } from "./commands/launch.ts";
import { list } from "./commands/list.ts";
import { login } from "./commands/login.ts";
import { remove } from "./commands/remove.ts";
import { sync } from "./commands/sync.ts";
import { command, load } from "./core/registry.ts";
import { promptLine, select } from "./ui.ts";

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
    const desktopOn = desktopConfigOf(profile)?.enabled === true;
    const action = await select(
      [
        "Sign in with another account",
        "Edit name or launcher",
        `Desktop app alias: ${desktopOn ? "on" : "off"}`,
        desktopOn ? `Open in desktop app now` : "Add a desktop app alias",
        "Remove profile",
        "Back",
      ],
      `${profile.label} (${command(profile)})`,
    );
    if (!action.ok || action.index === 5) continue;
    if (action.index === 0) await login(profile.slug, {});
    else if (action.index === 1) await edit(profile.slug, {});
    else if (action.index === 2) await toggleDesktop(profile.slug, desktopOn);
    else if (action.index === 3) {
      if (desktopOn) await desktopCommand(profile.slug);
      else await toggleDesktop(profile.slug, false);
    } else if (action.index === 4) await remove(profile.slug);
  }
}

async function toggleDesktop(slug: string, currentlyOn: boolean): Promise<void> {
  if (currentlyOn) {
    await setDesktopEnabled(slug, false);
    return;
  }
  const defaultName = await defaultAliasName(slug);
  const aliasName = await promptLine("Desktop alias name", defaultName);
  const color = await promptLine(
    "Icon badge color (auto/red/orange/yellow/green/teal/blue/purple/pink/cyan/lime/none)",
    "auto",
  );
  await setDesktopEnabled(slug, true, {
    aliasName: aliasName || undefined,
    color: color || undefined,
  });
}

async function defaultAliasName(slug: string): Promise<string> {
  try {
    const profile = (await load()).find((entry) => entry.slug === slug);
    if (!profile) return "";
    return desktopAliasName(profile, await detectDesktopApp());
  } catch {
    return "";
  }
}
