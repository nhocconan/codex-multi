import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProfileHome, isPrivateName } from "../src/core/profile-home.ts";

let root = "";
let base = "";
let manager = "";

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-home-"));
  base = join(root, "base");
  manager = join(root, "manager");
  process.env.CODEX_MULTI_BASE_HOME = base;
  process.env.CODEX_MULTI_HOME = manager;
  await fs.mkdir(join(base, "skills"), { recursive: true });
  await fs.mkdir(join(base, "ipc"), { recursive: true });
  await fs.mkdir(join(base, "process_manager"), { recursive: true });
  await fs.mkdir(join(base, "tmp"), { recursive: true });
  await fs.mkdir(join(base, "app-server-daemon"), { recursive: true });
  await fs.mkdir(join(base, "app-server-control"), { recursive: true });
  await fs.writeFile(join(base, "skills", "example.md"), "shared skill");
  await fs.writeFile(
    join(base, "config.toml"),
    'model = "gpt-test"\ncli_auth_credentials_store = "keyring"\n\n[features]\napps = true\n',
  );
  await fs.writeFile(join(base, "auth.json"), '{"secret":"must not link"}');
});

afterEach(async () => {
  delete process.env.CODEX_MULTI_BASE_HOME;
  delete process.env.CODEX_MULTI_HOME;
  await fs.rm(root, { recursive: true, force: true });
});

describe("profile home isolation", () => {
  it("shares non-auth state and writes a managed config", async () => {
    const home = await buildProfileHome("personal");
    expect(await fs.readFile(join(home, "skills", "example.md"), "utf8")).toBe("shared skill");
    await expect(fs.readFile(join(home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const config = await fs.readFile(join(home, "config.toml"), "utf8");
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).toContain('model = "gpt-test"');
    expect(config).toContain("[features]");
    expect(config).not.toContain('cli_auth_credentials_store = "keyring"');
    expect((await fs.lstat(join(home, "config.toml"))).isSymbolicLink()).toBe(false);
    for (const runtimeDirectory of ["ipc", "process_manager", "tmp", "app-server-daemon", "app-server-control"]) {
      await expect(fs.lstat(join(home, runtimeDirectory))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("rebuilds from the latest base config without touching profile auth", async () => {
    const home = await buildProfileHome("work");
    await fs.writeFile(join(home, "auth.json"), '{"auth_mode":"chatgpt","tokens":{"x":"y"}}');
    await fs.writeFile(join(base, "config.toml"), 'model = "new-model"\n');
    await buildProfileHome("work");
    expect(await fs.readFile(join(home, "config.toml"), "utf8")).toContain('model = "new-model"');
    expect(await fs.readFile(join(home, "auth.json"), "utf8")).toContain('"chatgpt"');
  });

  it("shares one live skills directory across every account profile", async () => {
    const personal = await buildProfileHome("personal");
    const work = await buildProfileHome("work");

    await fs.writeFile(join(base, "skills", "team-skill.md"), "available everywhere");

    await expect(fs.readFile(join(personal, "skills", "team-skill.md"), "utf8")).resolves.toBe(
      "available everywhere",
    );
    await expect(fs.readFile(join(work, "skills", "team-skill.md"), "utf8")).resolves.toBe(
      "available everywhere",
    );
  });

  it("recognizes credential and runtime-private names", () => {
    expect(isPrivateName("auth.json")).toBe(true);
    expect(isPrivateName("auth.json.backup")).toBe(true);
    expect(isPrivateName("auth.json.cpm-backup")).toBe(true);
    expect(isPrivateName("config.toml")).toBe(true);
    expect(isPrivateName("worker.lock")).toBe(true);
    expect(isPrivateName("ipc")).toBe(true);
    expect(isPrivateName("process_manager")).toBe(true);
    expect(isPrivateName("tmp")).toBe(true);
    expect(isPrivateName("app-server-daemon")).toBe(true);
    expect(isPrivateName("app-server-control")).toBe(true);
    expect(isPrivateName("skills")).toBe(false);
  });

  it.for([false, true])("removes legacy daemon links (dangling: %s) without touching base state or auth", async (dangling, context) => {
    const home = join(manager, "profiles", "teacher");
    await fs.mkdir(home, { recursive: true });
    const auth = '{"OPENAI_API_KEY":"fake-test-key"}';
    await fs.writeFile(join(home, "auth.json"), auth);
    for (const name of ["app-server-daemon", "app-server-control"]) {
      const target = join(base, name);
      await fs.writeFile(join(target, "keep.txt"), "base runtime state");
      try {
        await fs.symlink(dangling ? join(base, `missing-${name}`) : target, join(home, name),
          process.platform === "win32" ? "junction" : undefined);
      } catch (error) {
        if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          context.skip();
          return;
        }
        throw error;
      }
    }
    await buildProfileHome("teacher");
    await buildProfileHome("teacher");
    for (const name of ["app-server-daemon", "app-server-control"]) {
      await expect(fs.lstat(join(home, name))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(join(base, name, "keep.txt"), "utf8")).toBe("base runtime state");
    }
    expect(await fs.readFile(join(home, "auth.json"), "utf8")).toBe(auth);
  });

  it("preserves real profile daemon directories and files during sync", async () => {
    const home = join(manager, "profiles", "teacher");
    for (const name of ["app-server-daemon", "app-server-control"]) {
      await fs.mkdir(join(home, name), { recursive: true });
      await fs.writeFile(join(home, name, "keep.txt"), "profile runtime state");
    }
    await buildProfileHome("teacher");
    for (const name of ["app-server-daemon", "app-server-control"]) {
      expect((await fs.lstat(join(home, name))).isDirectory()).toBe(true);
      expect(await fs.readFile(join(home, name, "keep.txt"), "utf8")).toBe("profile runtime state");
    }
  });
});
