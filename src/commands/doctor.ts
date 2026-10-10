import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { authFingerprint, inspectAuth } from "../core/auth.ts";
import {
  desktopAliasName,
  desktopAliasPath,
  desktopAppsDir,
  desktopConfigOf,
  desktopSupported,
  isOwnedAliasBundle,
  ownedAliasBundles,
} from "../core/desktop.ts";
import {
  baseCodexHome,
  launcherPath,
  launchersDir,
  profileHome,
  resolveCodexBinary,
} from "../core/paths.ts";
import { command, isSeparated, load } from "../core/registry.ts";
import { launcherTargetDescription } from "../core/wrappers.ts";

export async function doctor(): Promise<number> {
  const profiles = await load();
  const errors: string[] = [];
  const warnings: string[] = [];
  console.log("Codex Multi doctor\n");
  console.log(`  Codex binary : ${resolveCodexBinary()}`);
  console.log(`  Base home    : ${baseCodexHome()}`);
  console.log(`  Profiles     : ${profiles.length}`);
  console.log(`  Launchers    : ${launchersDir()} → ${launcherTargetDescription()}`);
  if (desktopSupported()) console.log(`  Desktop dir  : ${desktopAppsDir()}`);
  console.log();

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
    if (!auth.ok) errors.push(`${profile.label}: ${auth.problem ?? "invalid auth"}`);
    const home = profileHome(profile.slug);
    console.log(`    home     : ${home}`);
    try {
      const config = await fs.readFile(join(home, "config.toml"), "utf8");
      if (!/^cli_auth_credentials_store\s*=\s*"file"/m.test(config)) {
        errors.push(`${profile.label}: config does not force file credential storage`);
      }
    } catch {
      errors.push(`${profile.label}: managed config.toml is missing`);
    }
    try {
      const homeEntries = await fs.readdir(home);
      for (const name of homeEntries) {
        if (!name.endsWith(".sqlite") || isSeparated(profile)) continue;
        const entryPath = join(home, name);
        const stat = await fs.lstat(entryPath);
        if (!stat.isSymbolicLink()) {
          const basePath = join(baseCodexHome(), name);
          try {
            const [entryStat, baseStat] = await Promise.all([
              fs.stat(entryPath),
              fs.stat(basePath),
            ]);
            if (entryStat.dev !== baseStat.dev || entryStat.ino !== baseStat.ino) {
              errors.push(
                `${profile.label}: ${name} is detached from base Codex state; run cpm sync to repair`,
              );
            }
          } catch {
            // Base doesn't have it or stat failed
          }
        }
      }
    } catch {
      // Home directory missing or unreadable
    }
    const launcher = launcherPath(profile.slug);
    try {
      const source = await fs.readFile(launcher, "utf8");
      console.log(`    launcher : ${source.includes("codex-multi launcher") ? "ready" : "foreign file"}`);
      if (!source.includes("codex-multi launcher")) {
        errors.push(`${profile.label}: launcher path is owned by another file`);
      }
    } catch {
      console.log("    launcher : missing");
      errors.push(`${profile.label}: launcher is missing; run cpm sync`);
    }
    const desktop = desktopConfigOf(profile);
    if (desktop?.enabled) {
      const alias = desktopAliasName(profile, { name: desktop.appName });
      const target = desktopAliasPath(alias);
      let problem: string | undefined;
      if (!existsSync(target)) {
        problem = "alias bundle is missing; run cpm sync";
      } else if (!(await isOwnedAliasBundle(target, profile.slug))) {
        problem = `${target} is owned by another app; choose a different name`;
      } else if (!existsSync(desktop.appPath)) {
        problem = `desktop app not found at ${desktop.appPath}; run "cpm edit ${profile.slug} --desktop" to refresh`;
      }
      console.log(`    desktop  : ${alias}${problem ? ` — ${problem}` : ""}`);
      if (problem) errors.push(`${profile.label}: ${problem}`);
    } else {
      console.log("    desktop  : off");
    }
    const fingerprint = await authFingerprint(profile.slug);
    if (fingerprint) {
      const owner = fingerprintOwners.get(fingerprint);
      if (owner) {
        warnings.push(`${profile.label} and ${owner} contain identical auth credentials`);
      } else {
        fingerprintOwners.set(fingerprint, profile.label);
      }
    }
    console.log();
  }

  if (desktopSupported()) {
    const wanted = new Set(
      profiles.filter((p) => desktopConfigOf(p)?.enabled).map((p) => p.slug),
    );
    for (const owned of await ownedAliasBundles()) {
      if (wanted.has(owned.slug)) continue;
      warnings.push(
        `desktop alias ${basename(owned.path)} (${owned.slug}) is not wanted by any enabled profile; run cpm sync`,
      );
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log("✓ No problems detected.");
    return 0;
  }
  if (errors.length > 0) {
    console.log("Errors:");
    for (const error of errors) console.log(`  ✖ ${error}`);
  }
  if (warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  }
  return errors.length > 0 ? 1 : 0;
}
