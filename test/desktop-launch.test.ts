import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { execMock, startupMock, callbackRouterMock } = vi.hoisted(() => ({
  execMock: vi.fn(), startupMock: vi.fn(), callbackRouterMock: vi.fn(),
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  Object.defineProperty(execMock, promisify.custom, { value: (...args: unknown[]) => execMock(...args) });
  return { execFile: execMock };
});
vi.mock("../src/core/desktop-runtime.ts", () => ({ waitForDesktopStartup: startupMock }));
vi.mock("../src/core/callback-router.ts", () => ({ ensureCallbackRouterHandler: callbackRouterMock }));
import { desktopInfoPlist, launchDesktop } from "../src/core/desktop.ts";
import type { Profile } from "../src/core/registry.ts";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root = "";
let profile: Profile;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-launch-"));
  const app = join(root, "Codex 'Work'.app");
  await fs.mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  profile = { slug: "work", label: "Work", createdAt: "2026-10-10", desktop: {
    enabled: true, appPath: app, appName: "Codex",
  } };
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  vi.stubEnv("CODEX_MULTI_HOME", root);
  vi.stubEnv("CODEX_MULTI_PROFILES_DIR", join(root, "profiles"));
  for (const key of ["CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_DESKTOP_RELAUNCH_OPEN_EVENTS",
    "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"]) vi.stubEnv(key, "fake-ambient-value");
  vi.stubEnv("CUSTOM_MCP_TOKEN", "fake-mcp-token");
  execMock.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  startupMock.mockReset().mockResolvedValue(undefined);
  callbackRouterMock.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("official app launch boundary", () => {
  it("discovers the installed app when a registered app path is stale", async () => {
    const installed = (profile.desktop as { appPath: string }).appPath;
    await fs.writeFile(join(installed, "Contents", "Info.plist"),
      '<plist><dict><key>CFBundleName</key><string>Codex</string></dict></plist>');
    vi.stubEnv("CODEX_MULTI_DESKTOP_APP", installed);
    (profile.desktop as { appPath: string }).appPath = join(root, "Missing.app");
    await launchDesktop(profile);
    expect(execMock.mock.calls.find(([file]) => file === "/usr/bin/open")![1][1]).toBe(installed);
  });

  it("passes exact isolated paths and clears Codex auth without dropping custom MCP environment", async () => {
    await launchDesktop(profile);
    const [file, args, options] = execMock.mock.calls[0]!;
    expect(file).toBe("/usr/bin/open");
    expect(args).toEqual(["-n", (profile.desktop as { appPath: string }).appPath, "--env",
      `CODEX_HOME=${join(root, "profiles", "work")}`, "--args", `--user-data-dir=${join(root, "desktop", "work")}`]);
    expect(options.env.CODEX_HOME).toBe(join(root, "profiles", "work"));
    for (const key of ["CODEX_ELECTRON_USER_DATA_PATH", "CODEX_DESKTOP_RELAUNCH_OPEN_EVENTS",
      "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"]) expect(options.env[key]).toBeUndefined();
    expect(options.env.CUSTOM_MCP_TOKEN).toBe("fake-mcp-token");
    expect(startupMock).toHaveBeenCalledWith("work");
    expect(callbackRouterMock).toHaveBeenCalledTimes(1);
    expect(callbackRouterMock.mock.invocationCallOrder[0]).toBeGreaterThan(startupMock.mock.invocationCallOrder[0]!);
  });

  it("reports native open failures without polling for startup", async () => {
    execMock.mockRejectedValueOnce(new Error("open failed"));
    await expect(launchDesktop(profile)).rejects.toThrow("open failed");
    expect(startupMock).not.toHaveBeenCalled();
    expect(callbackRouterMock).not.toHaveBeenCalled();
  });

  it("reports startup failures instead of claiming a successful launch", async () => {
    startupMock.mockRejectedValueOnce(new Error("did not start"));
    await expect(launchDesktop(profile)).rejects.toThrow("did not start");
    expect(callbackRouterMock).not.toHaveBeenCalled();
  });

  it("refreshes callback routing only after desktop startup completes", async () => {
    let finishStartup: () => void = () => {};
    startupMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishStartup = resolve; });
    });
    const launching = launchDesktop(profile);
    await vi.waitFor(() => expect(startupMock).toHaveBeenCalledWith("work"));
    expect(callbackRouterMock).not.toHaveBeenCalled();
    finishStartup();
    await launching;
    expect(callbackRouterMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the official codex URL scheme out of alias registration", () => {
    const plist = desktopInfoPlist("Codex Work", "work", "blue");
    expect(plist).not.toContain("CFBundleURLTypes");
    expect(plist).not.toContain("CFBundleURLSchemes");
  });
});
