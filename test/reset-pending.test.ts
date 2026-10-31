import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  Object.defineProperty(execMock, promisify.custom, { value: (...args: unknown[]) => execMock(...args) });
  return { execFile: execMock };
});

import { resetPendingDesktop } from "../src/commands/desktop.ts";
import { desktopPendingLaunchPath, prepareDesktopLaunch } from "../src/core/desktop-runtime.ts";
import { profileLifecycleLockPath, profileMutationLockPath } from "../src/core/paths.ts";
import { append } from "../src/core/registry.ts";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-reset-pending-"));
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  vi.stubEnv("CODEX_MULTI_HOME", root);
  vi.stubEnv("CODEX_MULTI_PROFILES_DIR", join(root, "profiles"));
  vi.stubEnv("CODEX_MULTI_PROFILES_FILE", join(root, "profiles.json"));
  vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
  execMock.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  await append({ slug: "work", label: "Work", createdAt: "2026-01-01" });
  await prepareDesktopLaunch("work");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", originalPlatform);
  await fs.rm(root, { recursive: true, force: true });
});

describe("pending launch recovery command", () => {
  it("requires explicit acknowledgement before acquiring locks or changing state", async () => {
    await expect(resetPendingDesktop("work", false)).rejects.toThrow("--confirm-quit");
    expect((await fs.lstat(desktopPendingLaunchPath("work"))).isFile()).toBe(true);
    await expect(fs.lstat(`${profileMutationLockPath("work")}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(console.log).not.toHaveBeenCalled();
  });

  it("refuses unknown profiles and preserves their marker", async () => {
    await prepareDesktopLaunch("orphan");
    await expect(resetPendingDesktop("orphan", true)).rejects.toThrow("unknown profile: orphan");
    expect((await fs.lstat(desktopPendingLaunchPath("orphan"))).isFile()).toBe(true);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("holds both actual profile locks while clearing an acknowledged launch", async () => {
    const unlink = fs.unlink.bind(fs);
    const mutationLock = `${profileMutationLockPath("work")}.lock`;
    const lifecycleLock = `${profileLifecycleLockPath("work")}.lock`;
    let clearedUnderLocks = false;
    vi.spyOn(fs, "unlink").mockImplementation(async (path) => {
      if (String(path) === desktopPendingLaunchPath("work")) {
        expect((await fs.lstat(mutationLock)).isDirectory()).toBe(true);
        expect((await fs.lstat(lifecycleLock)).isDirectory()).toBe(true);
        clearedUnderLocks = true;
      }
      await unlink(path);
    });
    await resetPendingDesktop("work", true);
    expect(clearedUnderLocks).toBe(true);
    await expect(fs.lstat(desktopPendingLaunchPath("work"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(mutationLock)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(lifecycleLock)).rejects.toMatchObject({ code: "ENOENT" });
    expect(console.log).toHaveBeenCalledWith("Cleared the pending desktop launch for work.");
  });

  it("refuses recovery while the selected profile is running", async () => {
    execMock.mockResolvedValue({ stdout: `123 /Applications/Codex.app/Contents/MacOS/Codex --user-data-dir=${join(root, "desktop", "work")}`, stderr: "" });
    await expect(resetPendingDesktop("work", true)).rejects.toThrow("is running");
    expect((await fs.lstat(desktopPendingLaunchPath("work"))).isFile()).toBe(true);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("preserves state when the running-process scan fails", async () => {
    execMock.mockRejectedValue(new Error("scan denied"));
    await expect(resetPendingDesktop("work", true)).rejects.toThrow("scan denied");
    expect((await fs.lstat(desktopPendingLaunchPath("work"))).isFile()).toBe(true);
    expect(console.log).not.toHaveBeenCalled();
  });
});
