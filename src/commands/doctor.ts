import { promises as fs } from "node:fs";
import { join } from "node:path";
import { authFingerprint, inspectAuth } from "../core/auth.ts";
import {
  baseCodexHome,
  launcherPath,
  launchersDir,
  profileHome,
  resolveCodexBinary,
} from "../core/paths.ts";
import { command, load } from "../core/registry.ts";
import { launcherTargetDescription } from "../core/wrappers.ts";

export async function doctor(): Promise<number> {
  const profiles = await load();
  const findings: string[] = [];
  console.log("Codex Multi doctor\n");
  console.log(`  Codex binary : ${resolveCodexBinary()}`);
  console.log(`  Base home    : ${baseCodexHome()}`);
  console.log(`  Profiles     : ${profiles.length}`);
  console.log(`  Launchers    : ${launchersDir()} → ${launcherTargetDescription()}\n`);

  if (profiles.length === 0) {
    console.log("No profiles configured. Run: cpm add");
    return 0;
  }

  const fingerprintOwners = new Map<string, string>();
  for (const profile of profiles) {
    console.log(`● ${profile.label} (${command(profile)})`);
    const auth = await inspectAuth(profile.slug);
    console.log(
      `    auth     : ${auth.ok ? `ready (${auth.mode})` : `INVALID — ${auth.problem ?? "unknown problem"}`}`,
    );
    if (!auth.ok) findings.push(`${profile.label}: ${auth.problem ?? "invalid auth"}`);
    const home = profileHome(profile.slug);
    console.log(`    home     : ${home}`);
    try {
      const config = await fs.readFile(join(home, "config.toml"), "utf8");
      if (!/^cli_auth_credentials_store\s*=\s*"file"/m.test(config)) {
        findings.push(`${profile.label}: config does not force file credential storage`);
      }
    } catch {
      findings.push(`${profile.label}: managed config.toml is missing`);
    }
    const launcher = launcherPath(profile.slug);
    try {
      const source = await fs.readFile(launcher, "utf8");
      console.log(`    launcher : ${source.includes("codex-multi launcher") ? "ready" : "foreign file"}`);
      if (!source.includes("codex-multi launcher")) {
        findings.push(`${profile.label}: launcher path is owned by another file`);
      }
    } catch {
      console.log("    launcher : missing");
      findings.push(`${profile.label}: launcher is missing; run cpm sync`);
    }
    const fingerprint = await authFingerprint(profile.slug);
    if (fingerprint) {
      const owner = fingerprintOwners.get(fingerprint);
      if (owner) {
        findings.push(`${profile.label} and ${owner} contain identical auth credentials`);
      } else {
        fingerprintOwners.set(fingerprint, profile.label);
      }
    }
    console.log();
  }

  if (findings.length === 0) {
    console.log("✓ No problems detected.");
    return 0;
  }
  console.log("Findings:");
  for (const finding of findings) console.log(`  ⚠ ${finding}`);
  return 1;
}
