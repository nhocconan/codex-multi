import { promises as fs, type Dirent } from "node:fs";
import { join } from "node:path";
import { baseCodexHome, profileHome } from "./paths.ts";
import { atomicWrite } from "./auth.ts";

const PRIVATE_NAMES = new Set([
  "auth.json",
  "config.toml",
  "codex-login.log",
  "ipc",
  "process_manager",
  "tmp",
  ".tmp",
]);

export function isPrivateName(name: string): boolean {
  if (PRIVATE_NAMES.has(name)) return true;
  if (/^auth\.json(?:[.-].+)?$/.test(name)) return true;
  if (name.endsWith(".lock") || name.endsWith(".sock")) return true;
  return false;
}

/**
 * Link all non-auth Codex state into a profile home. Existing real profile
 * files are preserved. This keeps config, skills, sessions, and plugins shared
 * while auth.json remains independently refreshable.
 */
export async function buildProfileHome(slug: string): Promise<string> {
  const base = baseCodexHome();
  const destination = profileHome(slug);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const desired = new Set<string>();
  for (const entry of entries) {
    if (isPrivateName(entry.name)) continue;
    desired.add(entry.name);
    const target = join(base, entry.name);
    const link = join(destination, entry.name);
    await ensureSharedEntry(link, target, entry.isDirectory());
  }

  let profileEntries: Dirent[] = [];
  try {
    profileEntries = await fs.readdir(destination, { withFileTypes: true });
  } catch {
    return destination;
  }
  for (const entry of profileEntries) {
    if (entry.name === "auth.json" || entry.name === "config.toml" || desired.has(entry.name)) {
      continue;
    }
    const path = join(destination, entry.name);
    try {
      if ((await fs.lstat(path)).isSymbolicLink()) await fs.unlink(path);
    } catch {
      // Best-effort stale-link cleanup.
    }
  }
  await writeProfileConfig(base, destination);
  return destination;
}

async function ensureSharedEntry(link: string, target: string, directory: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(link);
    if (!stat.isSymbolicLink()) return;
    const existing = await fs.readlink(link);
    if (existing === target) return;
    await fs.unlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }

  try {
    await fs.symlink(target, link, process.platform === "win32" && directory ? "junction" : undefined);
  } catch (error) {
    // On Windows, file symlinks can require Developer Mode. A hard link still
    // shares the current file contents and is safe for read-mostly Codex data.
    if (process.platform === "win32" && !directory) {
      try {
        await fs.link(target, link);
        return;
      } catch (linkError) {
        throw new Error(
          `could not share ${target} with a symlink or hard link: ${(linkError as Error).message}`,
        );
      }
    }
    throw new Error(`could not share ${target}: ${(error as Error).message}`);
  }
}

/**
 * Mirror the base config as a real file and force file-based credentials.
 * Codex can otherwise use a global keyring entry, defeating CODEX_HOME auth
 * isolation. The base file is re-read on every launch, so changes remain live.
 */
async function writeProfileConfig(base: string, destination: string): Promise<void> {
  let source = "";
  try {
    source = await fs.readFile(join(base, "config.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = source.split(/\r?\n/);
  let insideTable = false;
  const kept = lines.filter((line) => {
    if (/^\s*\[/.test(line)) insideTable = true;
    return insideTable || !/^\s*cli_auth_credentials_store\s*=/.test(line);
  });
  const content = [
    "# Managed by codex-profile-manager; regenerated from the base Codex config.",
    'cli_auth_credentials_store = "file"',
    ...kept,
  ].join("\n");
  await atomicWrite(join(destination, "config.toml"), content.endsWith("\n") ? content : `${content}\n`);
}
