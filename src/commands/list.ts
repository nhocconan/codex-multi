import { inspectAuth } from "../core/auth.ts";
import { command, load } from "../core/registry.ts";

export async function list(): Promise<void> {
  const profiles = await load();
  if (profiles.length === 0) {
    console.log("No Codex profiles configured. Run: cpm add");
    return;
  }
  for (const profile of profiles) {
    const auth = await inspectAuth(profile.slug);
    const details = auth.ok
      ? [auth.mode, auth.identity, auth.plan].filter(Boolean).join(" · ")
      : auth.problem;
    console.log(
      `${command(profile).padEnd(24)}  ${profile.label.padEnd(24)}  ${auth.ok ? "ready" : "needs login"}${details ? ` · ${details}` : ""}`,
    );
  }
}
