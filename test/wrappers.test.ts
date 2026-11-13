import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isTransientSelf, removeLauncher, syncLaunchers } from "../src/core/wrappers.ts";
import spawn from "cross-spawn";
import type { Profile } from "../src/core/registry.ts";
import { VERSION } from "../src/version.ts";

let root = "";
let oldArgv1 = "";

const personal: Profile = {
  slug: "personal",
  label: "Personal",
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-wrappers-"));
  process.env.CODEX_MULTI_BIN_DIR = join(root, "bin");
  oldArgv1 = process.argv[1] || "";
  const stableSelf = join(root, "cli.js");
  await fs.writeFile(stableSelf, "manager");
  process.argv[1] = stableSelf;
});

afterEach(async () => {
  process.argv[1] = oldArgv1;
  delete process.env.CODEX_MULTI_BIN_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe("launcher synchronization", () => {
  it("creates an owned codex-profile launcher", async () => {
    const result = await syncLaunchers([personal]);
    expect(result.created).toBe(1);
    const suffix = process.platform === "win32" ? ".cmd" : "";
    const source = await fs.readFile(join(root, "bin", `codex-personal${suffix}`), "utf8");
    expect(source).toContain("codex-multi launcher");
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

  it.for(["symbolic", "hard"])("preserves %s links even when their targets contain the ownership marker", async (kind, context) => {
    const suffix = process.platform === "win32" ? ".cmd" : "";
    const target = join(root, "user-target");
    const path = join(root, "bin", `codex-personal${suffix}`);
    await fs.mkdir(join(root, "bin"), { recursive: true });
    await fs.writeFile(target, "// codex-multi launcher\nuser file");
    try {
      if (kind === "symbolic") await fs.symlink(target, path);
      else await fs.link(target, path);
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    expect((await syncLaunchers([personal])).conflicts).toEqual([path]);
    expect((await syncLaunchers([])).removed).toBe(0);
    await removeLauncher("personal");
    expect(await fs.readFile(target, "utf8")).toBe("// codex-multi launcher\nuser file");
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(kind === "symbolic");
    if (kind === "hard") expect((await fs.lstat(path)).nlink).toBe(2);
  });

  it("leaves oversized and directory collisions untouched", async () => {
    const suffix = process.platform === "win32" ? ".cmd" : "";
    const path = join(root, "bin", `codex-personal${suffix}`);
    await fs.mkdir(join(root, "bin"), { recursive: true });
    const source = "// codex-multi launcher\n" + "x".repeat(65_536);
    await fs.writeFile(path, source);
    expect((await syncLaunchers([personal])).conflicts).toEqual([path]);
    await removeLauncher("personal");
    expect(await fs.readFile(path, "utf8")).toBe(source);
    await fs.unlink(path);
    await fs.mkdir(path);
    expect((await syncLaunchers([personal])).conflicts).toEqual([path]);
    await removeLauncher("personal");
    expect((await fs.lstat(path)).isDirectory()).toBe(true);
  });

  it("preserves argument boundaries and manager exit status through a generated launcher", async () => {
    const manager = join(root, "manager.cjs");
    const observed = join(root, "args.json");
    await fs.writeFile(manager, `require("node:fs").writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.argv.slice(2))); process.exit(7);`);
    process.argv[1] = manager;
    await syncLaunchers([personal]);
    const suffix = process.platform === "win32" ? ".cmd" : "";
    const launcher = join(root, "bin", `codex-personal${suffix}`);
    const args = ["exec", "two words", "--model", "test-model"];
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(launcher, args, { stdio: "pipe" });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(code).toBe(7);
    expect(JSON.parse(await fs.readFile(observed, "utf8"))).toEqual(["launch", "personal", "--", ...args]);
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
    expect(launcher).toContain(`codex-multi@${VERSION}`);
    // Must name the codex-multi bin explicitly so npx never falls back to
    // guessing among the package's multiple bins (cpm/codex-multi).
    expect(launcher).toContain(`--package=codex-multi@${VERSION}`);
    expect(launcher).toContain('"codex-multi"');
    expect(launcher).toContain("--prefix");
  });

  it("resolves manager dynamically with fallback when recorded self is missing", async () => {
    const missingSelf = join(root, "missing", "cli.js");
    process.argv[1] = missingSelf;
    await syncLaunchers([personal]);
    const suffix = process.platform === "win32" ? ".cmd" : "";
    const launcher = await fs.readFile(
      join(root, "bin", `codex-personal${suffix}`),
      "utf8",
    );
    if (process.platform === "win32") {
      expect(launcher).toContain("RECORDED_SELF");
      expect(launcher).toContain("codex-multi.cmd");
    } else {
      expect(launcher).toContain("resolveManager");
      expect(launcher).toContain("fs.existsSync(recorded)");
      expect(launcher).toContain('"codex-multi", "cpm"');
    }
  });
});
