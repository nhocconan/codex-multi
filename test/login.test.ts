import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authPath } from "../src/core/auth.ts";
import { login } from "../src/core/login.ts";
import type { Profile } from "../src/core/registry.ts";
import { assertDesktopStopped } from "../src/core/desktop-runtime.ts";

vi.mock("../src/core/desktop-runtime.ts", () => ({ assertDesktopStopped: vi.fn() }));

let root = "";
let profile: Profile;

beforeEach(async () => {
  vi.mocked(assertDesktopStopped).mockReset();
  root = await fs.mkdtemp(join(tmpdir(), "cpm-login-"));
  process.env.CODEX_MULTI_BASE_HOME = join(root, "base");
  process.env.CODEX_MULTI_HOME = join(root, "manager");
  process.env.CODEX_MULTI_CODEX_BIN = await fakeCodex(root);
  process.env.CPM_LOGIN_OUTPUT = join(root, "login.json");
  await fs.mkdir(join(root, "base"), { recursive: true });
  profile = { slug: "work", label: "Work", createdAt: "2026-01-01T00:00:00.000Z" };
});

afterEach(async () => {
  for (const key of [
    "CODEX_MULTI_BASE_HOME",
    "CODEX_MULTI_HOME",
    "CODEX_MULTI_CODEX_BIN",
    "CPM_LOGIN_OUTPUT",
    "CPM_LOGIN_EXIT",
    "CPM_TEST_API_KEY",
    "CPM_TEST_ACCESS_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
  ]) {
    delete process.env[key];
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("profile login", () => {
  it.each([
    [{ deviceAuth: true }, ["login", "--device-auth"]],
    [{}, ["login"]],
  ] as const)("runs browser and device login with the isolated home", async (options, args) => {
    await login(profile, options);
    const observed = JSON.parse(
      await fs.readFile(join(root, "login.json"), "utf8"),
    ) as { args: string[]; home: string };
    expect(observed.args).toEqual(args);
    expect(observed.home).toBe(join(root, "manager", "profiles", "work"));
  });

  it.each([
    ["apiKeyEnv", "CPM_TEST_API_KEY", "--with-api-key"],
    ["accessTokenEnv", "CPM_TEST_ACCESS_TOKEN", "--with-access-token"],
  ] as const)("passes %s only over stdin and scrubs ambient auth", async (option, envName, flag) => {
    process.env[envName] = "test-secret";
    process.env.OPENAI_API_KEY = "ambient-api-key";
    process.env.CODEX_ACCESS_TOKEN = "ambient-access-token";
    await login(profile, { [option]: envName });
    const observed = JSON.parse(
      await fs.readFile(join(root, "login.json"), "utf8"),
    ) as { args: string[]; stdin: string; hasAmbientAuth: boolean };
    expect(observed.args).toEqual(["login", flag]);
    expect(observed.stdin).toBe("test-secret\n");
    expect(observed.hasAmbientAuth).toBe(false);
  });

  it("restores the previous auth byte-for-byte when Codex login fails", async () => {
    const previous = Buffer.from(
      '{\n  "auth_mode": "chatgpt",\n  "tokens": {"refresh_token": "old"}\n}\n',
    );
    await fs.mkdir(join(root, "manager", "profiles", "work"), { recursive: true });
    await fs.writeFile(authPath("work"), previous);
    process.env.CPM_LOGIN_EXIT = "7";
    await expect(login(profile)).rejects.toThrow("status 7");
    expect(await fs.readFile(authPath("work"))).toEqual(previous);
  });

  it("replaces the account behind the same slug after a successful login", async () => {
    const previous = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { account_id: "old-account", access_token: "old-token" },
    });
    await fs.mkdir(join(root, "manager", "profiles", "work"), { recursive: true });
    await fs.writeFile(authPath("work"), previous);
    await login(profile);
    const current = JSON.parse(await fs.readFile(authPath("work"), "utf8")) as {
      tokens: { account_id: string };
    };
    expect(current.tokens.account_id).toBe("account-test");
    expect(await fs.readdir(join(root, "manager", "profiles", "work"))).not.toContain(
      "auth.json.cpm-backup",
    );
  });

  it("rejects conflicting secret modes before changing auth", async () => {
    await expect(
      login(profile, { apiKeyEnv: "CPM_TEST_API_KEY", accessTokenEnv: "CPM_TEST_ACCESS_TOKEN" }),
    ).rejects.toThrow("cannot be used together");
    await expect(fs.readFile(authPath("work"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps separated state private while refreshing its login", async () => {
    profile.separated = true;
    await fs.mkdir(join(root, "base", "sessions"));
    await fs.writeFile(join(root, "base", "history.jsonl"), "shared history");
    await login(profile);
    const home = join(root, "manager", "profiles", "work");
    await expect(fs.lstat(join(home, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(join(home, "history.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(authPath("work"))).isFile()).toBe(true);
  });

  it("refuses login before changing auth when the profile desktop is running", async () => {
    await fs.mkdir(join(root, "manager", "profiles", "work"), { recursive: true });
    const previous = JSON.stringify({ OPENAI_API_KEY: "fake-previous-key" });
    await fs.writeFile(authPath("work"), previous);
    vi.mocked(assertDesktopStopped).mockRejectedValue(new Error("Close desktop work first"));
    await expect(login(profile)).rejects.toThrow("Close desktop work first");
    expect(await fs.readFile(authPath("work"), "utf8")).toBe(previous);
    await expect(fs.lstat(join(root, "login.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fakeCodex(directory: string): Promise<string> {
  const scriptPath = join(directory, "fake-codex-login.js");
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const secretMode = args.includes("--with-api-key") || args.includes("--with-access-token");
let input = "";
if (secretMode) process.stdin.on("data", (chunk) => { input += chunk; });
const finish = () => {
  fs.writeFileSync(process.env.CPM_LOGIN_OUTPUT, JSON.stringify({
    args,
    home: process.env.CODEX_HOME,
    stdin: input,
    hasAmbientAuth: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN),
  }));
  const exitCode = Number(process.env.CPM_LOGIN_EXIT || 0);
  if (exitCode === 0) {
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { account_id: "account-test", access_token: "access-test" },
    }));
  }
  process.exit(exitCode);
};
if (secretMode) process.stdin.on("end", finish);
else finish();
`,
    { mode: 0o755 },
  );
  if (process.platform === "win32") {
    const commandPath = join(directory, "fake-codex-login.cmd");
    await fs.writeFile(
      commandPath,
      `@echo off\r\n"${process.execPath}" "%~dp0fake-codex-login.js" %*\r\n`,
    );
    return commandPath;
  }
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}
