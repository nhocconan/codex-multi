import { promises as fs, type Dirent } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { baseCodexHome, profileHome } from "./paths.ts";
import { assertProfileAuthIsolation } from "./auth.ts";
import { atomicWriteIfChanged } from "./atomic-write.ts";

const PRIVATE_NAMES = new Set([
  "auth.json",
  "config.toml",
  "codex-login.log",
  "ipc",
  "process_manager",
  "app-server-daemon",
  "app-server-control",
  "tmp",
  ".tmp",
]);

export function isPrivateName(name: string): boolean {
  name = name.toLowerCase();
  if (PRIVATE_NAMES.has(name)) return true;
  if (/^auth\.json(?:[.-].+)?$/.test(name)) return true;
  // Desktop app window/UI state; each profile keeps its own copy so
  // simultaneously running desktop instances never fight over one file.
  if (/^\.codex-global-state\.json(?:\.bak)?$/.test(name)) return true;
  if (name.endsWith(".lock") || name.endsWith(".sock")) return true;
  if (name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal")) return true;
  if (name.endsWith(".tmp") || /\.tmp-[0-9a-zA-Z-]+$/.test(name)) return true;
  return false;
}

/**
 * Link all non-auth Codex state into a profile home. Existing real profile
 * files are preserved. This keeps config, skills, sessions, and plugins shared
 * while auth.json remains independently refreshable. A separated profile
 * (`add --separated`) skips sharing and keeps all Codex state to itself.
 */
export async function buildProfileHome(slug: string, separated = false): Promise<string> {
  const base = baseCodexHome();
  const destination = profileHome(slug);
  await assertProfileAuthIsolation(slug);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await assertProfileAuthIsolation(slug);

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const credentials = await credentialIdentities(base, destination, entries);
  const protectedHomes = await Promise.all([base, destination].map(async (path) => {
    try { return await fs.realpath(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
      throw error;
    }
  }));
  const desired = new Set<string>();
  for (const entry of entries) {
    if (separated || isPrivateName(entry.name)) continue;
    const target = join(base, entry.name);
    if (!entry.isDirectory() && await aliasesCredential(target, credentials, entry.isSymbolicLink(), protectedHomes)) continue;
    desired.add(entry.name);
    const link = join(destination, entry.name);
    await ensureSharedEntry(link, target, entry.isDirectory());
  }

  const profileEntries = await fs.readdir(destination, { withFileTypes: true });
  for (const entry of profileEntries) {
    if (entry.name === "auth.json" || entry.name === "config.toml" || desired.has(entry.name)) {
      continue;
    }
    const path = join(destination, entry.name);
    try {
      const stat = await fs.lstat(path, { bigint: true });
      if (stat.isSymbolicLink() ||
        (stat.isFile() && stat.nlink > 1 && credentials.has(`${stat.dev}:${stat.ino}`))) {
        await fs.unlink(path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await writeProfileConfig(base, destination);
  return destination;
}

async function credentialIdentities(base: string, destination: string, entries: Dirent[]): Promise<Set<string>> {
  const paths = [
    join(destination, "auth.json"), join(destination, "auth.json.cpm-backup"),
    ...entries.filter((entry) => /^auth\.json(?:[.-].+)?$/i.test(entry.name))
      .map((entry) => join(base, entry.name)),
  ];
  const identities = new Set<string>();
  for (const path of paths) {
    try {
      const stat = await fs.stat(path, { bigint: true });
      identities.add(`${stat.dev}:${stat.ino}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return identities;
}

async function aliasesCredential(path: string, identities: Set<string>, symbolic: boolean, protectedHomes: string[]): Promise<boolean> {
  try {
    const stat = await fs.stat(path, { bigint: true });
    if (identities.has(`${stat.dev}:${stat.ino}`)) return true;
    if (symbolic) {
      const target = await fs.realpath(path);
      if (/^auth\.json(?:[.-].+)?$/i.test(basename(target))) return true;
      if (stat.isDirectory()) {
        if ((await fs.readdir(target)).some((name) => /^auth\.json(?:[.-].+)?$/i.test(name))) return true;
        return protectedHomes.some((home) => {
          const child = relative(target, home);
          return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
        });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return true;
  }
  return false;
}

async function ensureSharedEntry(link: string, target: string, directory: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(link);
    if (stat.isSymbolicLink()) {
      const existing = await fs.readlink(link);
      if (existing === target) return;
      await fs.unlink(link);
    } else {
      const [linkStat, targetStat] = await Promise.all([
        fs.stat(link, { bigint: true }).catch(() => null),
        fs.stat(target, { bigint: true }).catch(() => null),
      ]);
      if (
        linkStat &&
        targetStat &&
        linkStat.dev === targetStat.dev &&
        linkStat.ino === targetStat.ino
      ) {
        return;
      }
      if (stat.isFile()) {
        await fs.unlink(link);
      } else if (stat.isDirectory()) {
        try {
          await fs.rmdir(link);
        } catch {
          return;
        }
      }
    }
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
  let config: TomlTable;
  try {
    config = parse(source, { integersAsBigInt: true });
    config.cli_auth_credentials_store = "file";
    if (config.profiles && typeof config.profiles === "object" && !Array.isArray(config.profiles)) {
      for (const profile of Object.values(config.profiles)) {
        if (profile && typeof profile === "object" && !Array.isArray(profile)) {
          (profile as TomlTable).cli_auth_credentials_store = "file";
        }
      }
    }
  } catch {
    throw new Error("base config.toml is invalid; fix its TOML syntax before launching a profile");
  }
  const content = [
    "# Managed by codex-multi; regenerated from the base Codex config.",
    stringify(config, { numbersAsFloat: true }),
  ].join("\n");
  await atomicWriteIfChanged(join(destination, "config.toml"), content.endsWith("\n") ? content : `${content}\n`);
}
