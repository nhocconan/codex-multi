import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isTransientSelf, syncLaunchers } from "../src/core/wrappers.ts";
import type { Profile } from "../src/core/registry.ts";

let root = "";
let oldArgv1 = "";

const personal: Profile = {
  slug: "personal",
  label: "Personal",
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-wrappers-"));
  process.env.CODEX_PROFILE_MANAGER_BIN_DIR = join(root, "bin");
  oldArgv1 = process.argv[1] || "";
  const stableSelf = join(root, "cli.js");
  await fs.writeFile(stableSelf, "manager");
  process.argv[1] = stableSelf;
});

afterEach(async () => {
  process.argv[1] = oldArgv1;
  delete process.env.CODEX_PROFILE_MANAGER_BIN_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe("launcher synchronization", () => {
  it("creates an owned codex-profile launcher", async () => {
    const result = await syncLaunchers([personal]);
    expect(result.created).toBe(1);
    const suffix = process.platform === "win32" ? ".cmd" : "";
    const source = await fs.readFile(join(root, "bin", `codex-personal${suffix}`), "utf8");
    expect(source).toContain("codex-profile-manager launcher");
    expect(source).toContain("personal");
  });

  it("does not overwrite a foreign launcher", async () => {
    await fs.mkdir(join(root, "bin"), { recursive: true });
    const suffix = process.platform === "win32" ? ".cmd" : "";
    const path = join(root, "bin", `codex-personal${suffix}`);
    await fs.writeFile(path, "user-owned");
    const result = await syncLaunchers([personal]);
    expect(result.conflicts).toEqual([path]);
    expect(await fs.readFile(path, "utf8")).toBe("user-owned");
  });

  it("removes only stale manager-owned launchers", async () => {
    const suffix = process.platform === "win32" ? ".cmd" : "";
    await syncLaunchers([personal]);
    const foreign = join(root, "bin", `codex-foreign${suffix}`);
    await fs.writeFile(foreign, "user-owned");
    const result = await syncLaunchers([]);
    expect(result.removed).toBe(1);
    expect(await fs.readFile(foreign, "utf8")).toBe("user-owned");
  });

  it("uses a durable npx fallback for transient source entry points", async () => {
    const sourceEntry = join(root, "src", "cli.ts");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.writeFile(sourceEntry, "source");
    process.argv[1] = sourceEntry;
    expect(isTransientSelf(sourceEntry)).toBe(true);
    await syncLaunchers([personal]);
    const suffix = process.platform === "win32" ? ".cmd" : "";
    const launcher = await fs.readFile(
      join(root, "bin", `codex-personal${suffix}`),
      "utf8",
    );
    expect(launcher).toContain("npx");
    expect(launcher).toContain("codex-profile-manager@0.1.0");
  });
});
