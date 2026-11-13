import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
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
  vi.restoreAllMocks();
  delete process.env.CODEX_MULTI_BASE_HOME;
  delete process.env.CODEX_MULTI_HOME;
  await fs.rm(root, { recursive: true, force: true });
});

describe("profile home isolation", () => {
  it("fails closed when profile enumeration cannot verify private runtime state", async () => {
    const home = join(manager, "profiles", "personal");
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === home) throw Object.assign(new Error("profile directory unreadable"), { code: "EACCES" });
      return await readdir(...args);
    });

    await expect(buildProfileHome("personal")).rejects.toThrow("profile directory unreadable");
  });

  it("fails closed when a legacy credential hard link cannot be removed", async () => {
    const home = join(manager, "profiles", "personal");
    const unsafe = join(home, "saved-login");
    await fs.mkdir(home, { recursive: true });
    await fs.link(join(base, "auth.json"), unsafe);
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (path) => {
      if (path === unsafe) throw Object.assign(new Error("unsafe link removal denied"), { code: "EACCES" });
      return await unlink(path);
    });

    await expect(buildProfileHome("personal")).rejects.toThrow("unsafe link removal denied");
    expect(await fs.readFile(join(base, "auth.json"), "utf8")).toBe('{"secret":"must not link"}');
  });

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

  it("forces file credentials for quoted, escaped, dotted and inline profile settings", async () => {
    await fs.writeFile(join(base, "config.toml"), [
      '"cli_auth_credentials_store" = "keyring"',
      'profiles.work.cli_auth_credentials_store = "keyring"',
      'profiles.inline = { "cli_auth_credentials_store" = "auto", model = "test-model" }',
      '[profiles."quoted profile"]',
      '"cli_auth_credentials_\\u0073tore" = "keyring"',
      'model = "other-model"',
    ].join("\n"));

    const home = await buildProfileHome("personal");
    const config = parse(await fs.readFile(join(home, "config.toml"), "utf8"));
    expect(config).toEqual({
      cli_auth_credentials_store: "file",
      profiles: {
        work: { cli_auth_credentials_store: "file" },
        inline: { cli_auth_credentials_store: "file", model: "test-model" },
        "quoted profile": { cli_auth_credentials_store: "file", model: "other-model" },
      },
    });
  });

  it("preserves multiline text, integer precision, floats, dates and unknown config values", async () => {
    const source = [
      'instructions = """',
      '[This is text, not a table]',
      'cli_auth_credentials_store = "keyring"',
      '"""',
      "future_integer = 9223372036854775807",
      "future_float = 1.0",
      "future_date = 2026-11-13",
      "future_array = [{ enabled = true, score = 1.5 }]",
      '[profiles.work]',
      'cli_auth_credentials_store = "keyring"',
    ].join("\n");
    await fs.writeFile(join(base, "config.toml"), source);
    const expected = parse(source, { integersAsBigInt: true });
    expected.cli_auth_credentials_store = "file";
    (expected.profiles as Record<string, Record<string, unknown>>).work!.cli_auth_credentials_store = "file";

    const home = await buildProfileHome("personal");
    const actual = parse(await fs.readFile(join(home, "config.toml"), "utf8"), { integersAsBigInt: true });

    expect(actual).toEqual(expected);
    expect(typeof actual.future_integer).toBe("bigint");
    expect(typeof actual.future_float).toBe("number");
    expect(await fs.readFile(join(base, "config.toml"), "utf8")).toBe(source);
  });

  it("reports malformed config without exposing source secrets or replacing a working config", async () => {
    const home = await buildProfileHome("personal");
    const original = await fs.readFile(join(home, "config.toml"), "utf8");
    await fs.writeFile(join(base, "config.toml"), 'token = "fake-secret-that-must-stay-private');

    await expect(buildProfileHome("personal")).rejects.toThrow("base config.toml is invalid");
    await expect(buildProfileHome("personal")).rejects.not.toThrow("fake-secret");
    expect(await fs.readFile(join(home, "config.toml"), "utf8")).toBe(original);
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

  it.for(["symbolic", "hard"] as const)("does not share credentials hidden behind a %s link", async (kind, context) => {
    const alias = join(base, "saved-login");
    try {
      if (kind === "symbolic") await fs.symlink(join(base, "auth.json"), alias);
      else await fs.link(join(base, "auth.json"), alias);
    } catch (error) {
      if (kind === "symbolic" && process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    const home = await buildProfileHome("personal");
    await expect(fs.lstat(join(home, "saved-login"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(alias, "utf8")).toBe('{"secret":"must not link"}');
  });

  it("cleans up legacy credential hard links without removing independent profile files", async () => {
    const home = join(manager, "profiles", "personal");
    await fs.mkdir(home, { recursive: true });
    await fs.link(join(base, "auth.json"), join(base, "saved-login"));
    await fs.link(join(base, "auth.json"), join(home, "saved-login"));
    await fs.writeFile(join(home, "independent-file"), "keep this");

    await buildProfileHome("personal");

    await expect(fs.lstat(join(home, "saved-login"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(base, "auth.json"), "utf8")).toBe('{"secret":"must not link"}');
    expect(await fs.readFile(join(home, "independent-file"), "utf8")).toBe("keep this");
  });

  it.for(["missing-file", "base-home", "base-parent", "other-home"] as const)("does not share a credential alias to %s", async (targetKind, context) => {
    const target = targetKind === "missing-file" ? join(base, "auth.json.future")
      : targetKind === "base-home" ? base : targetKind === "other-home" ? join(root, "other-profile") : root;
    if (targetKind === "other-home") {
      await fs.mkdir(target);
      await fs.writeFile(join(target, "auth.json"), '{"OPENAI_API_KEY":"fake-other-profile-key"}');
    }
    try {
      await fs.symlink(target, join(base, "saved-login"),
        process.platform === "win32" && targetKind !== "missing-file" ? "junction" : undefined);
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    const home = await buildProfileHome("personal");
    await expect(fs.lstat(join(home, "saved-login"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(join(base, "saved-login"))).isSymbolicLink()).toBe(true);
  });

  it("recognizes credential and runtime-private names", () => {
    expect(isPrivateName("auth.json")).toBe(true);
    expect(isPrivateName("auth.json.backup")).toBe(true);
    expect(isPrivateName("auth.json.cpm-backup")).toBe(true);
    expect(isPrivateName("AUTH.JSON")).toBe(true);
    expect(isPrivateName("Auth.Json.Backup")).toBe(true);
    expect(isPrivateName("config.toml")).toBe(true);
    expect(isPrivateName("worker.lock")).toBe(true);
    expect(isPrivateName("ipc")).toBe(true);
    expect(isPrivateName("process_manager")).toBe(true);
    expect(isPrivateName("tmp")).toBe(true);
    expect(isPrivateName("app-server-daemon")).toBe(true);
    expect(isPrivateName("app-server-control")).toBe(true);
    expect(isPrivateName("queue_1.sqlite-wal")).toBe(true);
    expect(isPrivateName("queue_1.sqlite-shm")).toBe(true);
    expect(isPrivateName("state_5.sqlite-journal")).toBe(true);
    expect(isPrivateName("scratch.tmp")).toBe(true);
    expect(isPrivateName("..codex-global-state.json.tmp-1784875321170-fd571d54-006c-4390-89b6-403c17a95c4c")).toBe(true);
    expect(isPrivateName("queue_1.sqlite")).toBe(false);
    expect(isPrivateName("state_5.sqlite")).toBe(false);
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

  it("does not link sqlite wal/shm runtime files and cleans up legacy links", async () => {
    const home = join(manager, "profiles", "personal");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(join(base, "queue_1.sqlite"), "queue db");
    await fs.writeFile(join(base, "queue_1.sqlite-wal"), "queue wal");
    await fs.writeFile(join(base, "queue_1.sqlite-shm"), "queue shm");

    try {
      await fs.symlink(join(base, "queue_1.sqlite-wal"), join(home, "queue_1.sqlite-wal"));
      await fs.symlink(join(base, "queue_1.sqlite-shm"), join(home, "queue_1.sqlite-shm"));
    } catch {
      // Tolerate Windows symlink restrictions
    }

    await buildProfileHome("personal");

    expect(await fs.readFile(join(home, "queue_1.sqlite"), "utf8")).toBe("queue db");
    await expect(fs.lstat(join(home, "queue_1.sqlite-wal"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(join(home, "queue_1.sqlite-shm"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.for([false, true])("replaces detached regular files with shared links (large identifiers: %s)", async (largeIdentifiers) => {
    const home = join(manager, "profiles", "personal");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(join(base, "queue_1.sqlite"), "canonical db");
    await fs.writeFile(join(home, "queue_1.sqlite"), "detached stale db");

    if (largeIdentifiers) {
      const stat = fs.stat.bind(fs);
      vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
        const result = await stat(...args);
        if (args[0] === join(base, "queue_1.sqlite") || args[0] === join(home, "queue_1.sqlite")) {
          const ino = args[0] === join(base, "queue_1.sqlite") ? 2n ** 60n : 2n ** 60n + 1n;
          return Object.assign(result, { ino: typeof result.ino === "bigint" ? ino : Number(ino) });
        }
        return result;
      }) as typeof fs.stat);
    }

    await buildProfileHome("personal");

    expect(await fs.readFile(join(home, "queue_1.sqlite"), "utf8")).toBe("canonical db");
    const stat = await fs.lstat(join(home, "queue_1.sqlite"));
    if (process.platform !== "win32") {
      expect(stat.isSymbolicLink()).toBe(true);
    }
  });
});
