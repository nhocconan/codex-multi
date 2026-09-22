import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { Profile } from "./registry.ts";
import {
  launcherName,
  launchersDir,
  resolveSelfBinary,
} from "./paths.ts";
import { VERSION } from "../version.ts";

const MARKER = "codex-multi launcher";

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
  const recordedSelf = transient ? "null" : JSON.stringify(self);
  return `#!/usr/bin/env node
// ${MARKER}
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function resolveManager() {
  const recorded = ${recordedSelf};
  if (recorded && fs.existsSync(recorded)) {
    return { command: process.execPath, prefix: [recorded] };
  }

  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const selfReal = (() => {
    try { return fs.realpathSync(__filename); } catch { return __filename; }
  })();

  for (const binName of ["codex-multi", "cpm"]) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, binName);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const candReal = (() => {
            try { return fs.realpathSync(candidate); } catch { return candidate; }
          })();
          if (candReal !== selfReal) {
            return { command: candidate, prefix: [] };
          }
        }
      } catch {}
    }
  }

  return {
    command: "npx",
    prefix: ["--prefix", os.tmpdir(), "--yes", "--package=codex-multi@${VERSION}", "codex-multi"],
  };
}

const { command, prefix } = resolveManager();
const child = spawn(command, [...prefix, "launch", ${JSON.stringify(slug)}, "--", ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error("Could not start codex-multi:", error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
`;
}

function windowsLauncher(slug: string, self: string, transient: boolean): string {
  const recordedSelf = transient ? "" : self.replace(/"/g, "");
  const execPath = process.execPath.replace(/"/g, "");
  return `@echo off\r
rem ${MARKER}\r
setlocal\r
set "RECORDED_SELF=${recordedSelf}"\r
if defined RECORDED_SELF if exist "%RECORDED_SELF%" (\r
  "${execPath}" "%RECORDED_SELF%" launch ${slug} -- %*\r
  exit /b %errorlevel%\r
)\r
for %%I in (codex-multi.cmd codex-multi.exe cpm.cmd cpm.exe) do (\r
  if not "%%~$PATH:I"=="" (\r
    "%%~$PATH:I" launch ${slug} -- %*\r
    exit /b %errorlevel%\r
  )\r
)\r
npx --prefix "%TEMP%" --yes --package=codex-multi@${VERSION} "codex-multi" launch ${slug} -- %*\r
exit /b %errorlevel%\r
`;
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
    ? `npx codex-multi@${VERSION} (durable fallback)`
    : basename(self);
}
