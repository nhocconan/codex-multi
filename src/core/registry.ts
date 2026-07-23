import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
  launcherName,
  profileHome,
  profileHomesDir,
  profileMutationLockPath,
  profilesFile,
} from "./paths.ts";
import { processIsRunning, withFileLock } from "./lock.ts";

export interface Profile {
  slug: string;
  label: string;
  createdAt: string;
  [key: string]: unknown;
}

export function command(profile: Profile): string {
  return launcherName(profile.slug);
}

export function validSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

export function validLabel(label: string): boolean {
  return label.length > 0 && !/[\u0000-\u001f\u007f]/.test(label);
}

export function slugify(label: string): string {
  let slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.startsWith("codex-")) slug = slug.slice("codex-".length);
  return slug;
}

export async function load(): Promise<Profile[]> {
  await recoverRemovalTombstones();
  return await loadRegistered();
}

/** Read the current atomic registry snapshot without running tombstone recovery. */
export async function loadRegistered(): Promise<Profile[]> {
  return profilesFromRows(await readRows());
}

function profilesFromRows(rows: unknown[]): Profile[] {
  const seen = new Set<string>();
  const profiles: Profile[] = [];
  for (const item of rows) {
    const profile = asProfile(item);
    if (!profile || seen.has(profile.slug)) continue;
    seen.add(profile.slug);
    profiles.push(profile);
  }
  return profiles;
}

async function recoverRemovalTombstones(): Promise<void> {
  for (const tombstone of await removalTombstones()) {
    if (processIsRunning(tombstone.ownerPid)) continue;
    await withFileLock(profileMutationLockPath(tombstone.slug), async () => {
      await resolveRemovalTombstoneLocked(tombstone.slug, tombstone.path);
    });
  }
}

/** Reconcile one slug after its mutation lock has already been acquired. */
export async function recoverProfileRemovalLocked(slug: string): Promise<void> {
  for (const tombstone of await removalTombstones(slug)) {
    if (processIsRunning(tombstone.ownerPid)) continue;
    await resolveRemovalTombstoneLocked(slug, tombstone.path);
  }
}

async function removalTombstones(
  onlySlug?: string,
): Promise<Array<{ slug: string; ownerPid: number; path: string }>> {
  const root = profileHomesDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: Array<{ slug: string; ownerPid: number; path: string }> = [];
  for (const entry of entries) {
    const match =
      entry.isDirectory() &&
      /^([a-z0-9]+(?:-[a-z0-9]+)*)\.cpm-removing-(\d+)-\d+$/.exec(entry.name);
    if (!match) continue;
    const slug = match[1]!;
    if (onlySlug && slug !== onlySlug) continue;
    const ownerPid = Number(match[2]);
    result.push({ slug, ownerPid, path: join(root, entry.name) });
  }
  return result;
}

async function resolveRemovalTombstoneLocked(
  slug: string,
  tombstone: string,
): Promise<void> {
  await withFileLock(`${profilesFile()}.lock`, async () => {
    const registered = (await readRows()).some((item) => asProfile(item)?.slug === slug);
    if (!registered) {
      await fs.rm(tombstone, { recursive: true, force: true });
      return;
    }
    const home = profileHome(slug);
    try {
      await fs.lstat(home);
      throw new Error(
        `cannot recover ${slug}: both its profile home and removal tombstone exist`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(tombstone, home).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  });
}

export async function find(slug: string): Promise<Profile | undefined> {
  return (await load()).find((profile) => profile.slug === slug);
}

/** Read a profile while its mutation lock is already held. */
export async function findRegistered(slug: string): Promise<Profile | undefined> {
  return profilesFromRows(await readRows()).find((profile) => profile.slug === slug);
}

async function readRows(): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(profilesFile(), "utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error(`${profilesFile()} must contain a JSON array`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function asProfile(item: unknown): Profile | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  const slug = typeof record.slug === "string" ? record.slug : "";
  const label = typeof record.label === "string" ? record.label : "";
  if (!validSlug(slug) || !validLabel(label)) return undefined;
  return {
    ...record,
    slug,
    label,
    createdAt:
      typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
  };
}

async function writeAll(rows: unknown[]): Promise<void> {
  const path = profilesFile();
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(rows, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporary, path);
}

export async function append(profile: Profile): Promise<void> {
  await withFileLock(`${profilesFile()}.lock`, async () => {
    const rows = await readRows();
    if (rows.some((item) => asProfile(item)?.slug === profile.slug)) {
      throw new Error(`profile ${profile.slug} already exists`);
    }
    rows.push(profile);
    await writeAll(rows);
  });
}

export async function rewrite(oldSlug: string, profile: Profile): Promise<void> {
  await withFileLock(`${profilesFile()}.lock`, async () => {
    const rows = await readRows();
    const index = rows.findIndex((item) => asProfile(item)?.slug === oldSlug);
    if (index < 0) throw new Error(`unknown profile: ${oldSlug}`);
    if (
      oldSlug !== profile.slug &&
      rows.some((item) => asProfile(item)?.slug === profile.slug)
    ) {
      throw new Error(`profile ${profile.slug} already exists`);
    }
    const current = rows[index];
    rows[index] =
      current && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>), ...profile }
        : profile;
    await writeAll(rows);
  });
}

export async function remove(slug: string): Promise<void> {
  await withFileLock(`${profilesFile()}.lock`, async () => {
    const rows = await readRows();
    await writeAll(rows.filter((item) => asProfile(item)?.slug !== slug));
  });
}
