import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { doctor } from "../src/commands/doctor.ts";
import { append } from "../src/core/registry.ts";
import { atomicWrite } from "../src/core/auth.ts";
import { syncLaunchers } from "../src/core/wrappers.ts";

let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-doctor-test-"));
  process.env.CODEX_MULTI_HOME = root;
  process.env.CODEX_MULTI_BASE_HOME = join(root, "base-codex");
  process.env.CODEX_MULTI_BIN_DIR = join(root, "bin");
  process.env.CODEX_MULTI_CODEX_BIN = "codex";
  await fs.mkdir(join(root, "base-codex"), { recursive: true });
  await fs.writeFile(
    join(root, "base-codex", "config.toml"),
    'cli_auth_credentials_store = "file"\nmodel = "o3"\n',
  );
});

afterEach(async () => {
  delete process.env.CODEX_MULTI_HOME;
  delete process.env.CODEX_MULTI_BASE_HOME;
  delete process.env.CODEX_MULTI_BIN_DIR;
  delete process.env.CODEX_MULTI_CODEX_BIN;
  await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("cpm doctor", () => {
  it("returns 0 when no profiles are registered", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await doctor();
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("No profiles configured"));
  });

  it("returns 0 when profiles are completely healthy", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const profile = { slug: "work", label: "Work", createdAt: new Date().toISOString() };
    await append(profile);
    const profileHome = join(root, "profiles", "work");
    await fs.mkdir(profileHome, { recursive: true });
    await fs.writeFile(
      join(profileHome, "config.toml"),
      'cli_auth_credentials_store = "file"\n',
    );
    await atomicWrite(
      join(profileHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-test-work-12345" }),
    );
    await syncLaunchers([profile]);

    const code = await doctor();
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("No problems detected"));
  });

  it("returns 0 and reports warnings when profiles have duplicate credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const p1 = { slug: "work", label: "Work", createdAt: new Date().toISOString() };
    const p2 = { slug: "backup", label: "Backup", createdAt: new Date().toISOString() };
    await append(p1);
    await append(p2);

    for (const p of [p1, p2]) {
      const pHome = join(root, "profiles", p.slug);
      await fs.mkdir(pHome, { recursive: true });
      await fs.writeFile(
        join(pHome, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
      );
      await atomicWrite(
        join(pHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-shared-key-12345" }),
      );
    }
    await syncLaunchers([p1, p2]);

    const code = await doctor();
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith("Warnings:");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("contain identical auth credentials"),
    );
  });

  it("returns 1 and reports errors when auth is missing or invalid", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const profile = { slug: "broken", label: "Broken", createdAt: new Date().toISOString() };
    await append(profile);
    const pHome = join(root, "profiles", "broken");
    await fs.mkdir(pHome, { recursive: true });
    await fs.writeFile(
      join(pHome, "config.toml"),
      'cli_auth_credentials_store = "file"\n',
    );
    // auth.json is intentionally missing

    const code = await doctor();
    expect(code).toBe(1);
    expect(log).toHaveBeenCalledWith("Errors:");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("auth.json is missing"));
  });
});
