import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { Profile } from "./registry.ts";
import {
  launcherName,
  launchersDir,
  resolveSelfBinary,
} from "./paths.ts";
import { VERSION } from "../version.ts";

const MARKER = "codex-profile-manager launcher";

export interface SyncResult {
  created: number;
  updated: number;
  removed: number;
  conflicts: string[];
  dir: string;
}

export function isTransientSelf(path: string): boolean {
  return (
    path.endsWith(".ts") ||
    /[\\/]_npx[\\/]|[\\/]\.npm[\\/]_cacache[\\/]/.test(path) ||
    !existsSync(path)
  );
}

export async function syncLaunchers(profiles: Profile[]): Promise<SyncResult> {
  const dir = launchersDir();
  const self = resolveSelfBinary();
  const transient = isTransientSelf(self);
  const result: SyncResult = { created: 0, updated: 0, removed: 0, conflicts: [], dir };
  await fs.mkdir(dir, { recursive: true });

  const wanted = new Set<string>();
  for (const profile of profiles) {
    const filename =
      launcherName(profile.slug) + (process.platform === "win32" ? ".cmd" : "");
    wanted.add(filename);
    const path = join(dir, filename);
    const content =
      process.platform === "win32"
        ? windowsLauncher(profile.slug, self, transient)
        : unixLauncher(profile.slug, self, transient);

    try {
      const existing = await fs.readFile(path, "utf8");
      if (!existing.includes(MARKER)) {
        result.conflicts.push(path);
        continue;
      }
      if (existing !== content) {
        await writeLauncher(path, content);
        result.updated++;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        result.conflicts.push(path);
        continue;
      }
      await writeLauncher(path, content);
      result.created++;
    }
  }

  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const normalized = entry.name.replace(/\.cmd$/i, "");
    if (!normalized.startsWith("codex-") || wanted.has(entry.name)) continue;
    const path = join(dir, entry.name);
    try {
      const content = await fs.readFile(path, "utf8");
      if (!content.includes(MARKER)) continue;
      await fs.unlink(path);
      result.removed++;
    } catch {
      // Ignore entries that are not regular manager-owned files.
    }
  }
  return result;
}

export async function removeLauncher(slug: string): Promise<void> {
  const filename = launcherName(slug) + (process.platform === "win32" ? ".cmd" : "");
  const path = join(launchersDir(), filename);
  try {
    const content = await fs.readFile(path, "utf8");
    if (content.includes(MARKER)) await fs.unlink(path);
  } catch {
    // Missing or foreign launchers are intentionally untouched.
  }
}

function unixLauncher(slug: string, self: string, transient: boolean): string {
  const managerCommand = transient
    ? `const command = "npx";\nconst prefix = ["--yes", "codex-profile-manager@${VERSION}"];`
    : `const command = process.execPath;\nconst prefix = [${JSON.stringify(self)}];`;
  return `#!/usr/bin/env node
// ${MARKER}
const { spawn } = require("node:child_process");
${managerCommand}
const child = spawn(command, [...prefix, "launch", ${JSON.stringify(slug)}, "--", ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error("Could not start codex-profile-manager:", error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
`;
}

function windowsLauncher(slug: string, self: string, transient: boolean): string {
  if (transient) {
    return `@echo off\r\nrem ${MARKER}\r\nnpx --yes codex-profile-manager@${VERSION} launch ${slug} -- %*\r\n`;
  }
  return `@echo off\r\nrem ${MARKER}\r\n"${process.execPath}" "${self}" launch ${slug} -- %*\r\n`;
}

async function writeLauncher(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o755 });
  await fs.rename(temporary, path);
  if (process.platform !== "win32") await fs.chmod(path, 0o755);
}

export function launcherTargetDescription(): string {
  const self = resolveSelfBinary();
  return isTransientSelf(self)
    ? `npx codex-profile-manager@${VERSION} (durable fallback)`
    : basename(self);
}
