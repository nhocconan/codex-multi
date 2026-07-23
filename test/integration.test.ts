import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { add } from "../src/commands/add.ts";
import { launch } from "../src/commands/launch.ts";
import { remove } from "../src/commands/remove.ts";
import { edit } from "../src/commands/edit.ts";
import { profileHome, profileLifecycleLockPath } from "../src/core/paths.ts";
import { authBackupPath, authPath } from "../src/core/auth.ts";
import { find, remove as removeRegistry } from "../src/core/registry.ts";

let root = "";
let originalPath: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-integration-"));
  process.env.CODEX_MULTI_BASE_HOME = join(root, "base");
  process.env.CODEX_MULTI_HOME = join(root, "manager");
  process.env.CODEX_MULTI_BIN_DIR = join(root, "bin");
  originalPath = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}${delimiter}${originalPath ?? ""}`;
  await fs.mkdir(join(root, "base"), { recursive: true });
  await fs.writeFile(join(root, "base", "config.toml"), 'model = "shared"\n');
  await fs.writeFile(
    join(root, "base", "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "access", refresh_token: "refresh" },
    }),
  );
  process.env.CODEX_MULTI_CODEX_BIN = await fakeCodex(root);
  process.env.CPM_FAKE_OUTPUT = join(root, "launch.json");
});

afterEach(async () => {
  for (const key of [
    "CODEX_MULTI_BASE_HOME",
    "CODEX_MULTI_HOME",
    "CODEX_MULTI_BIN_DIR",
    "CODEX_MULTI_CODEX_BIN",
    "CPM_FAKE_OUTPUT",
    "CPM_FAKE_DELAY_MS",
  ]) {
    delete process.env[key];
  }
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  await fs.rm(root, { recursive: true, force: true });
});

describe("import and launch", () => {
  it.skipIf(process.platform === "win32")(
    "runs Codex with isolated auth and shared config",
    async () => {
      const baseAuthBefore = await fs.readFile(join(root, "base", "auth.json"));
      await add({ name: "Personal", slug: "personal", importCurrent: true });
      await fs.rename(authPath("personal"), authBackupPath("personal"));
      const code = await launch("personal", ["exec", "hello"]);
      expect(code).toBe(0);
      const observed = JSON.parse(
        await fs.readFile(join(root, "launch.json"), "utf8"),
      ) as { argv: string[]; codexHome: string; hasApiKey: boolean };
      expect(observed.argv).toEqual(["exec", "hello"]);
      expect(observed.codexHome).toBe(join(root, "manager", "profiles", "personal"));
      expect(observed.hasApiKey).toBe(false);
      expect(
        await fs.readFile(join(observed.codexHome, "config.toml"), "utf8"),
      ).toContain('model = "shared"');
      await remove("personal", true);
      expect(await fs.readFile(join(root, "base", "auth.json"))).toEqual(baseAuthBefore);
      await expect(fs.lstat(profileHome("personal"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not delete a pre-existing orphan profile directory", async () => {
    const orphan = profileHome("orphan");
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(join(orphan, "keep.txt"), "do not delete");
    await expect(
      add({ name: "Orphan", slug: "orphan", importCurrent: true }),
    ).rejects.toThrow("already exists");
    expect(await fs.readFile(join(orphan, "keep.txt"), "utf8")).toBe("do not delete");
  });

  it("keeps a committed profile when launcher creation fails", async () => {
    const blocked = join(root, "blocked-launcher-path");
    await fs.writeFile(blocked, "not a directory");
    process.env.CODEX_MULTI_BIN_DIR = blocked;
    await expect(
      add({ name: "Saved", slug: "saved", importCurrent: true }),
    ).resolves.toBeUndefined();
    expect(await find("saved")).toMatchObject({ label: "Saved" });
    expect((await fs.lstat(authPath("saved"))).isFile()).toBe(true);
  });

  it("serializes concurrent adds for the same slug without deleting the winner", async () => {
    const results = await Promise.allSettled([
      add({ name: "First", slug: "shared", importCurrent: true }),
      add({ name: "Second", slug: "shared", importCurrent: true }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await find("shared")).toBeDefined();
    expect((await fs.lstat(authPath("shared"))).isFile()).toBe(true);
  });

  it("does not overwrite an orphan directory while renaming", async () => {
    await add({ name: "Original", slug: "original", importCurrent: true });
    const reserved = profileHome("reserved");
    await fs.mkdir(reserved, { recursive: true });
    await fs.writeFile(join(reserved, "keep.txt"), "keep");
    await expect(
      edit("original", { name: "Renamed", slug: "reserved" }),
    ).rejects.toThrow("already exists");
    expect(await find("original")).toBeDefined();
    expect(await fs.readFile(join(reserved, "keep.txt"), "utf8")).toBe("keep");
  });

  it("rejects terminal control characters in display names", async () => {
    await expect(
      add({ name: "Unsafe\u001b[31m", slug: "unsafe", importCurrent: true }),
    ).rejects.toThrow("control characters");
    expect(await find("unsafe")).toBeUndefined();
  });

  it("recovers interrupted removal before and after the registry commit", async () => {
    await add({ name: "Restore", slug: "restore", importCurrent: true });
    const restoreHome = profileHome("restore");
    const restoreTombstone = `${restoreHome}.cpm-removing-2147483647-1`;
    await fs.rename(restoreHome, restoreTombstone);
    expect(await find("restore")).toBeDefined();
    expect((await fs.lstat(restoreHome)).isDirectory()).toBe(true);

    await add({ name: "Finish", slug: "finish", importCurrent: true });
    const finishHome = profileHome("finish");
    const finishTombstone = `${finishHome}.cpm-removing-2147483647-2`;
    await fs.rename(finishHome, finishTombstone);
    await removeRegistry("finish");
    expect(await find("finish")).toBeUndefined();
    await expect(fs.lstat(finishTombstone)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can safely re-add a slug whose committed removal left a tombstone", async () => {
    await add({ name: "Old", slug: "reused", importCurrent: true });
    const home = profileHome("reused");
    const tombstone = `${home}.cpm-removing-2147483647-3`;
    await fs.rename(home, tombstone);
    await removeRegistry("reused");
    await add({ name: "New", slug: "reused", importCurrent: true });
    expect(await find("reused")).toMatchObject({ label: "New" });
    expect((await fs.lstat(authPath("reused"))).isFile()).toBe(true);
    await expect(fs.lstat(tombstone)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "holds the lifecycle lock until the launched Codex process exits",
    async () => {
      await add({ name: "Busy", slug: "busy", importCurrent: true });
      process.env.CPM_FAKE_DELAY_MS = "150";
      const launched = launch("busy", ["exec"]);
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await fs.lstat(join(root, "launch.json"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      expect(
        (await fs.lstat(`${profileLifecycleLockPath("busy")}.lock`)).isDirectory(),
      ).toBe(true);
      await expect(launched).resolves.toBe(0);
      await expect(
        fs.lstat(`${profileLifecycleLockPath("busy")}.lock`),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

async function fakeCodex(directory: string): Promise<string> {
  const path = join(directory, "fake-codex");
  await fs.writeFile(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CPM_FAKE_OUTPUT, JSON.stringify({
  argv: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME,
  hasApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN),
}));
const delay = Number(process.env.CPM_FAKE_DELAY_MS || 0);
if (delay > 0) setTimeout(() => {}, delay);
`,
    { mode: 0o755 },
  );
  await fs.chmod(path, 0o755);
  return path;
}
