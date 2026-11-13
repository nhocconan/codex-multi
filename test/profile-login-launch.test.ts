import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launch } from "../src/commands/launch.ts";
import { authPath } from "../src/core/auth.ts";
import { append } from "../src/core/registry.ts";
import { assertDesktopStopped } from "../src/core/desktop-runtime.ts";
import { select } from "../src/ui.ts";

vi.mock("../src/core/desktop-runtime.ts", () => ({ assertDesktopStopped: vi.fn() }));
vi.mock("../src/ui.ts", () => ({ select: vi.fn() }));

let root: string;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const profile = { slug: "conan", label: "Conan", createdAt: "2026-01-01" };

beforeEach(async () => {
  vi.resetAllMocks();
  root = await fs.mkdtemp(join(tmpdir(), "cpm-relogin-"));
  vi.stubEnv("CODEX_MULTI_HOME", join(root, "manager"));
  vi.stubEnv("CODEX_MULTI_BASE_HOME", join(root, "base"));
  vi.stubEnv("CPM_RELOGIN_OUTPUT", join(root, "calls.jsonl"));
  await fs.mkdir(join(root, "base"));
  await fs.writeFile(join(root, "base", "auth.json"), '{"OPENAI_API_KEY":"fake-base"}');
  const script = join(root, "fake-codex.cjs");
  await fs.writeFile(script, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CPM_RELOGIN_OUTPUT, JSON.stringify({args, home: process.env.CODEX_HOME}) + "\\n");
const command = args.find(arg => ["login", "logout", "exec", "app"].includes(arg));
if (command === "login" && !args.some(arg => ["status", "help", "--help", "-h"].includes(arg))) {
  if (!process.env.CPM_RELOGIN_NO_AUTH) {
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), '{"OPENAI_API_KEY":"fake-new"}');
  }
  process.exit(Number(process.env.CPM_RELOGIN_EXIT || 0));
}
process.exit(Number(process.env.CPM_RELOGIN_EXIT || 0));
`, { mode: 0o755 });
  let binary = script;
  if (process.platform === "win32") {
    binary = join(root, "fake-codex.cmd");
    await fs.writeFile(binary, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  vi.stubEnv("CODEX_MULTI_CODEX_BIN", binary);
  await append(profile);
});

afterEach(async () => {
  for (const [stream, descriptor] of [[process.stdin, stdinTty], [process.stdout, stdoutTty]] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function calls(): Promise<{ args: string[]; home: string }[]> {
  return (await fs.readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(line => {
    const call = JSON.parse(line) as { args: string[]; home: string };
    expect(call.args.slice(0, 2)).toEqual(["-c", 'cli_auth_credentials_store="file"']);
    call.args.splice(0, 2);
    return call;
  });
}

function tty(interactive: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: interactive });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: interactive });
}

describe("logged-out profile launchers", () => {
  it("blocks recovery from replacing credentials under an active desktop", async () => {
    await fs.mkdir(join(root, "manager", "profiles", "conan"), { recursive: true });
    await fs.writeFile(authPath("conan"), "{}");
    const backup = `${authPath("conan")}.cpm-backup`;
    await fs.writeFile(backup, '{"OPENAI_API_KEY":"fake-backup"}');
    vi.mocked(assertDesktopStopped).mockRejectedValue(new Error("Close desktop first"));
    await expect(launch("conan", ["exec", "hello"])).rejects.toThrow("Close desktop first");
    expect(await fs.readFile(authPath("conan"), "utf8")).toBe("{}");
    expect(await fs.readFile(backup, "utf8")).toBe('{"OPENAI_API_KEY":"fake-backup"}');
    await expect(calls()).rejects.toMatchObject({ code: "ENOENT" });
  });
  async function previousAuth(): Promise<string> {
    await fs.mkdir(join(root, "manager", "profiles", "conan"), { recursive: true });
    const previous = '{"OPENAI_API_KEY":"fake-existing","future":true}';
    await fs.writeFile(authPath("conan"), previous);
    return previous;
  }

  it.each([
    ["-C", "workspace", "login", "--device-auth"],
    ["-c", 'model="test"', "login", "--device-auth"],
    ["--config=model=\"test\"", "--strict-config", "login", "--device-auth"],
    ["-Cworkspace", "--enable", "example", "login", "--device-auth"],
    ["--image=fixture.png", "login", "--device-auth"],
    ["-ifixture.png", "login", "--device-auth"],
  ])("blocks prefixed login while desktop is active: %j", async (...args) => {
    const previous = await previousAuth();
    vi.mocked(assertDesktopStopped).mockRejectedValue(new Error("Close desktop first"));
    await expect(launch("conan", args)).rejects.toThrow("Close desktop first");
    await expect(calls()).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(authPath("conan"), "utf8")).toBe(previous);
  });

  it("preserves global prefix arguments and restores auth after a prefixed login failure", async () => {
    const previous = await previousAuth();
    const args = ["-c", 'model="test"', "login", "--device-auth"];
    vi.stubEnv("CPM_RELOGIN_EXIT", "7");

    await expect(launch("conan", args)).rejects.toThrow("status 7");

    expect((await calls())[0]?.args).toEqual(args);
    expect(await fs.readFile(authPath("conan"), "utf8")).toBe(previous);
    await expect(fs.stat(`${authPath("conan")}.cpm-backup`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([["logout"], ["-c", 'model="test"', "logout"], ["-ifixture.png", "logout"]])("blocks logout while desktop is active: %j", async (...args) => {
    const previous = await previousAuth();
    vi.mocked(assertDesktopStopped).mockRejectedValue(new Error("Close desktop first"));

    await expect(launch("conan", args)).rejects.toThrow("Close desktop first");

    expect(await fs.readFile(authPath("conan"), "utf8")).toBe(previous);
    await expect(calls()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["exec", "login"], ["exec", "--", "login"], ["exec", "logout"],
    ["-C", "login", "exec", "hello"], ["--image", "login"],
  ])("preserves prompts and root-option values literally: %j", async (...args) => {
    await previousAuth();
    await expect(launch("conan", args)).resolves.toBe(0);
    expect((await calls())[0]?.args).toEqual(args);
    expect(assertDesktopStopped).not.toHaveBeenCalled();
  });

  it.each([
    ["--help"], ["--version"], ["-C", "workspace", "--help"],
    ["-c", 'model="test"', "login", "status"], ["login", "-c", 'model="test"', "status"],
    ["-C", "workspace", "login", "--help"], ["logout", "--help"], ["app", "--help"],
  ])("allows read-only help/status without credentials: %j", async (...args) => {
    await expect(launch("conan", args)).resolves.toBe(0);
    expect((await calls())[0]?.args).toEqual(args);
    expect(assertDesktopStopped).not.toHaveBeenCalled();
    await expect(fs.stat(authPath("conan"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([["app"], ["-C", "workspace", "app"], ["app", "workspace"], ["app", "--", "--help"]])("directs native desktop launches to the isolated command: %j", async (...args) => {
    await expect(launch("conan", args)).rejects.toThrow("Use cpm desktop conan");
    await expect(calls()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps app help to native help without opening a workspace called help", async () => {
    await expect(launch("conan", ["app", "help"])).resolves.toBe(0);
    expect((await calls())[0]?.args).toEqual(["app", "--help"]);
  });

  it("rejects unsafe prefixed credential-store overrides before creating auth", async () => {
    await expect(launch("conan", ["-c", 'cli_auth_credentials_store="keyring"', "login", "--device-auth"])).rejects.toThrow("require cli_auth_credentials_store");
    await expect(calls()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(authPath("conan"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.for([["exec", "hello"], ["login", "--device-auth"], ["login", "status"]])("blocks linked credentials before starting Codex: %j", async (args, context) => {
    await fs.mkdir(join(root, "manager", "profiles", "conan"), { recursive: true });
    try {
      await fs.symlink(join(root, "base", "auth.json"), authPath("conan"));
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(launch("conan", args)).rejects.toThrow("real, unlinked files");
    await expect(calls()).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(root, "base", "auth.json"), "utf8")).toBe('{"OPENAI_API_KEY":"fake-base"}');
    expect((await fs.lstat(authPath("conan"))).isSymbolicLink()).toBe(true);
  });

  it("allows device login through the same launch route used by npx wrappers", async () => {
    await expect(launch("conan", ["--", "login", "--device-auth"])).resolves.toBe(0);
    expect(await calls()).toEqual([{ args: ["login", "--device-auth"], home: join(root, "manager", "profiles", "conan") }]);
    expect(JSON.parse(await fs.readFile(authPath("conan"), "utf8"))).toEqual({ OPENAI_API_KEY: "fake-new" });
    expect(await fs.readFile(join(root, "base", "auth.json"), "utf8")).toBe('{"OPENAI_API_KEY":"fake-base"}');
    expect(select).not.toHaveBeenCalled();
  });

  it.each(["status", "--help", "help", "-h"])("allows login %s without credentials or replacing auth", async arg => {
    await expect(launch("conan", ["login", arg])).resolves.toBe(0);
    expect((await calls())[0]?.args).toEqual(["login", arg]);
    await expect(fs.stat(authPath("conan"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(assertDesktopStopped).not.toHaveBeenCalled();
  });

  it("restores existing auth when an alias login fails", async () => {
    await fs.mkdir(join(root, "manager", "profiles", "conan"), { recursive: true });
    const previous = '{ "OPENAI_API_KEY": "fake-old", "future": true }\n';
    await fs.writeFile(authPath("conan"), previous);
    vi.stubEnv("CPM_RELOGIN_EXIT", "7");
    await expect(launch("conan", ["login", "--device-auth"])).rejects.toThrow("status 7");
    expect(await fs.readFile(authPath("conan"), "utf8")).toBe(previous);
  });

  it("blocks alias login while its desktop profile is active", async () => {
    vi.mocked(assertDesktopStopped).mockRejectedValue(new Error("Close desktop first"));
    await expect(launch("conan", ["login", "--device-auth"])).rejects.toThrow("Close desktop first");
    await expect(calls()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves login status exit codes and existing credentials", async () => {
    await fs.mkdir(join(root, "manager", "profiles", "conan"), { recursive: true });
    const previous = '{"OPENAI_API_KEY":"fake-existing"}';
    await fs.writeFile(authPath("conan"), previous);
    vi.stubEnv("CPM_RELOGIN_EXIT", "1");
    await expect(launch("conan", ["login", "status"])).resolves.toBe(1);
    expect(await fs.readFile(authPath("conan"), "utf8")).toBe(previous);
  });

  it("rejects a login that exits successfully without writing credentials", async () => {
    vi.stubEnv("CPM_RELOGIN_NO_AUTH", "1");
    await expect(launch("conan", ["login", "--device-auth"])).rejects.toThrow("auth.json is missing");
    await expect(fs.stat(authPath("conan"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${authPath("conan")}.cpm-backup`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([0, 1])("offers login and resumes the original command after choice %i", async index => {
    tty(true);
    vi.mocked(select).mockResolvedValue({ ok: true, index });
    await expect(launch("conan", ["exec", "hello"])).resolves.toBe(0);
    expect((await calls()).map(call => call.args)).toEqual([
      index === 0 ? ["login", "--device-auth"] : ["login"], ["exec", "hello"],
    ]);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it.each([{ ok: false }, { ok: true, index: 2 }] as const)("cancels recovery without starting Codex: %j", async choice => {
    tty(true);
    vi.mocked(select).mockResolvedValue(choice);
    await expect(launch("conan", [])).resolves.toBe(0);
    await expect(calls()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives noninteractive npx users runnable recovery commands", async () => {
    tty(false);
    await expect(launch("conan", ["exec", "hello"])).rejects.toThrow("codex-conan login --device-auth");
    await expect(launch("conan", [])).rejects.toThrow("npx --yes --package=codex-multi@latest codex-multi login conan --device-auth");
    expect(select).not.toHaveBeenCalled();
  });

  it("launches normally without a login prompt when credentials exist", async () => {
    tty(true);
    await fs.mkdir(join(root, "manager", "profiles", "conan"), { recursive: true });
    await fs.writeFile(authPath("conan"), '{"OPENAI_API_KEY":"fake-existing"}');
    await expect(launch("conan", ["exec", "hello"])).resolves.toBe(0);
    expect((await calls()).map(call => call.args)).toEqual([["exec", "hello"]]);
    expect(select).not.toHaveBeenCalled();
  });

  it("detects empty credentials and stops before launching if recovery fails", async () => {
    tty(true);
    await fs.mkdir(join(root, "manager", "profiles", "conan"), { recursive: true });
    await fs.writeFile(authPath("conan"), "{}");
    vi.mocked(select).mockResolvedValue({ ok: true, index: 0 });
    vi.stubEnv("CPM_RELOGIN_EXIT", "7");
    await expect(launch("conan", ["exec", "hello"])).rejects.toThrow("status 7");
    expect((await calls()).map(call => call.args)).toEqual([["login", "--device-auth"]]);
    expect(await fs.readFile(authPath("conan"), "utf8")).toBe("{}");
  });
});
