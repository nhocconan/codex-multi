import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Native behavior runs only on macOS. Linux/Windows retain the cross-platform
// TypeScript router tests; this suite never registers a handler or sends URLs.
describe.skipIf(process.platform !== "darwin")("native callback router", () => {
  let root = "";
  let executable = "";

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "cpm-native-router-"));
    executable = join(root, "CallbackRouter");
    await execFileAsync("swiftc", [
      resolve("native", "macos", "CallbackRouter.swift"),
      "-o", executable,
      "-framework", "AppKit",
      "-framework", "CoreServices",
    ], { timeout: 30_000 });
  }, 60_000);

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("checks production URL/path validation, bounded queue, and confirmed handler registration", async () => {
    const { stdout, stderr } = await execFileAsync(executable, ["--self-test"], { timeout: 30_000 });
    expect(stdout.trim()).toMatch(/^\d+ native router assertions passed$/);
    expect(Number.parseInt(stdout, 10)).toBeGreaterThanOrEqual(30);
    expect(`${stdout}${stderr}`).not.toContain("codex://");
    expect(stderr).toBe("");
  }, 60_000);

  it("lists no destinations without a baked profile root and exits without UI", async () => {
    const { stdout, stderr } = await execFileAsync(executable, ["--destinations"], { timeout: 30_000 });
    expect(JSON.parse(stdout)).toEqual([]);
    expect(stderr).toBe("");
  }, 60_000);

  it("rejects unknown arguments without starting the callback UI", async () => {
    await expect(execFileAsync(executable, ["--unknown"], { timeout: 30_000 })).rejects.toMatchObject({ code: 2 });
  }, 60_000);
});
