import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  launcherName,
  launcherPath,
  launchersDir,
  profileHome,
  profileHomesDir,
  profileLifecycleLockPath,
  profileMutationLockPath,
} from "../src/core/paths.ts";
import { launch } from "../src/commands/launch.ts";

let root = "";
let originalPath: string | undefined;
let originalProfilesDir: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-paths-"));
  originalPath = process.env.PATH;
  originalProfilesDir = process.env.CODEX_MULTI_PROFILES_DIR;
  process.env.CODEX_MULTI_PROFILES_DIR = join(root, "profiles");
  delete process.env.CODEX_MULTI_BIN_DIR;
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalProfilesDir === undefined) delete process.env.CODEX_MULTI_PROFILES_DIR;
  else process.env.CODEX_MULTI_PROFILES_DIR = originalProfilesDir;
  delete process.env.CODEX_MULTI_BIN_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe("launcher path selection", () => {
  it("honors an explicit launcher directory", () => {
    const explicit = join(root, "explicit");
    process.env.CODEX_MULTI_BIN_DIR = explicit;
    expect(launchersDir()).toBe(explicit);
  });

  it("skips transient npx and node_modules bin directories", async () => {
    const npxBin = join(root, "_npx", "123", "node_modules", ".bin");
    const projectBin = join(root, "project", "node_modules", ".bin");
    const durableBin = join(root, "durable-bin");
    await Promise.all(
      [npxBin, projectBin, durableBin].map((directory) =>
        fs.mkdir(directory, { recursive: true }),
      ),
    );
    process.env.PATH = [npxBin, projectBin, durableBin].join(delimiter);
    expect(launchersDir()).toBe(durableBin);
  });
});

describe("profile path boundaries", () => {
  it.each(["../outside", "../../outside", "..\\outside", "/absolute", "C:\\outside", "", "multi", "Work", "work/../../outside", "work\u0000"])("rejects unsafe slug %j in every profile path", (slug) => {
    for (const path of [profileHome, profileMutationLockPath, profileLifecycleLockPath, launcherName, launcherPath]) {
      expect(() => path(slug)).toThrow("invalid profile slug");
    }
  });

  it.each(["work", "work-2", "a", "123", "account-12-test"])("keeps valid slug %s within its profile root", (slug) => {
    expect(profileHome(slug)).toBe(join(profileHomesDir(), slug));
    expect(profileMutationLockPath(slug)).toBe(join(profileHomesDir(), `.cpm-mutation-${slug}.lock`));
    expect(profileLifecycleLockPath(slug)).toBe(join(profileHomesDir(), `.cpm-lifecycle-${slug}.lock`));
    expect(launcherName(slug)).toBe(`codex-${slug}`);
  });

  it("rejects a traversal launch before creating any lock directories", async () => {
    const before = await fs.readdir(root);
    await expect(launch("../outside", [])).rejects.toThrow("invalid profile slug");
    expect(await fs.readdir(root)).toEqual(before);
  });
});
