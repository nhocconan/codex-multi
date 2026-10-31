import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authFingerprint, copyCurrentAuth, inspectAuth, recoverAuthBackup } from "../src/core/auth.ts";
import { buildProfileHome } from "../src/core/profile-home.ts";

let root: string;
let base: string;
let home: string;
const fakeBaseAuth = '{"OPENAI_API_KEY":"fake-base-key"}';

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-auth-isolation-"));
  base = join(root, "base");
  home = join(root, "manager", "profiles", "work");
  vi.stubEnv("CODEX_MULTI_HOME", join(root, "manager"));
  vi.stubEnv("CODEX_MULTI_BASE_HOME", base);
  await fs.mkdir(base);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(join(base, "auth.json"), fakeBaseAuth);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("credential link rejection", () => {
  it.for(["auth.json", "auth.json.cpm-backup"])("rejects a linked %s without changing either login", async (name, context) => {
    const path = join(home, name);
    try {
      await fs.symlink(join(base, "auth.json"), path);
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(recoverAuthBackup("work")).rejects.toThrow("real, unlinked files");
    await expect(copyCurrentAuth("work")).rejects.toThrow("real, unlinked files");
    await expect(buildProfileHome("work")).rejects.toThrow("real, unlinked files");
    expect((await inspectAuth("work")).ok).toBe(false);
    expect(await authFingerprint("work")).toBeUndefined();
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(join(base, "auth.json"), "utf8")).toBe(fakeBaseAuth);
  });

  it.each(["auth.json", "auth.json.cpm-backup"])("rejects a hard-linked %s", async (name) => {
    await fs.link(join(base, "auth.json"), join(home, name));
    await expect(recoverAuthBackup("work")).rejects.toThrow("real, unlinked files");
    await expect(buildProfileHome("work")).rejects.toThrow("real, unlinked files");
    expect((await inspectAuth("work")).ok).toBe(false);
    expect(await fs.readFile(join(base, "auth.json"), "utf8")).toBe(fakeBaseAuth);
  });

  it("rejects a directory in place of credentials", async () => {
    await fs.mkdir(join(home, "auth.json"));
    await expect(recoverAuthBackup("work")).rejects.toThrow("real, unlinked files");
    expect((await inspectAuth("work")).ok).toBe(false);
  });

  it("rejects a symbolic profile home before writing base config", async (context) => {
    await fs.rmdir(home);
    await fs.writeFile(join(base, "config.toml"), 'model = "original"\n');
    try {
      await fs.symlink(base, home, process.platform === "win32" ? "junction" : undefined);
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(buildProfileHome("work")).rejects.toThrow("real directory");
    await expect(recoverAuthBackup("work")).rejects.toThrow("real directory");
    expect(await fs.readFile(join(base, "config.toml"), "utf8")).toBe('model = "original"\n');
    expect(await fs.readFile(join(base, "auth.json"), "utf8")).toBe(fakeBaseAuth);
  });

  it("rejects a base home configured to be the real profile home", async () => {
    vi.stubEnv("CODEX_MULTI_BASE_HOME", home);
    await fs.writeFile(join(home, "auth.json"), fakeBaseAuth);
    await expect(buildProfileHome("work")).rejects.toThrow("separate from the base");
    await expect(copyCurrentAuth("work")).rejects.toThrow("separate from the base");
    expect(await fs.readFile(join(home, "auth.json"), "utf8")).toBe(fakeBaseAuth);
  });

  it("rejects a missing profile home equal to the missing base before creating files", async () => {
    await fs.rmdir(home);
    vi.stubEnv("CODEX_MULTI_BASE_HOME", join(home, "..", "work"));
    await expect(buildProfileHome("work")).rejects.toThrow("separate from the base");
    await expect(recoverAuthBackup("work")).rejects.toThrow("separate from the base");
    await expect(fs.lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(base, "auth.json"), "utf8")).toBe(fakeBaseAuth);
  });

  it("rechecks missing homes after creation to reject symlinked ancestor aliases", async (context) => {
    const realParent = join(root, "physical");
    const aliasParent = join(root, "alias");
    await fs.mkdir(realParent);
    try {
      await fs.symlink(realParent, aliasParent, process.platform === "win32" ? "junction" : undefined);
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    vi.stubEnv("CODEX_MULTI_BASE_HOME", join(realParent, "work"));
    vi.stubEnv("CODEX_MULTI_PROFILES_DIR", aliasParent);
    await expect(buildProfileHome("work")).rejects.toThrow("separate from the base");
    expect(await fs.readdir(join(realParent, "work"))).toEqual([]);
    expect(await fs.readFile(join(base, "auth.json"), "utf8")).toBe(fakeBaseAuth);
  });

  it("restores a real backup and accepts independent credentials", async () => {
    const previous = '{"OPENAI_API_KEY":"fake-profile-key","future":true}';
    await fs.writeFile(join(home, "auth.json.cpm-backup"), previous);
    await recoverAuthBackup("work");
    expect(await fs.readFile(join(home, "auth.json"), "utf8")).toBe(previous);
    expect((await inspectAuth("work")).ok).toBe(true);
    expect(await fs.readFile(join(base, "auth.json"), "utf8")).toBe(fakeBaseAuth);
  });
});
