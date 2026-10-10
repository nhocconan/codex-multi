import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  Object.defineProperty(execFileMock, promisify.custom, {
    value: (...args: unknown[]) => new Promise((resolve, reject) => {
      execFileMock(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
  });
  return { execFile: execFileMock };
});

import {
  callbackRouter,
  ensureCallbackRouterHandler,
  routerPaths,
  routerPlist,
  routerAgentPlist,
} from "../src/core/callback-router.ts";
import { readPlistValues } from "../src/core/desktop.ts";

let root = "";
let stateRoot = "";
let appsDir = "";
let agentsDir = "";
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-callback-router-"));
  stateRoot = join(root, "state 'quotes' & spaces");
  appsDir = join(root, "Applications");
  agentsDir = join(root, "LaunchAgents");
  vi.stubEnv("CODEX_MULTI_HOME", stateRoot);
  vi.stubEnv("CODEX_MULTI_APPS_DIR", appsDir);
  vi.stubEnv("CODEX_MULTI_LAUNCH_AGENTS_DIR", agentsDir);
  vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", "1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  execFileMock.mockReset();
  execFileMock.mockImplementation((_file, _args, optionsOrCallback, callback?: ExecCallback) => {
    const done = typeof optionsOrCallback === "function" ? optionsOrCallback as ExecCallback : callback!;
    done(null, "", "");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
  await fs.rm(root, { recursive: true, force: true });
});

async function writeBundlePlist(contents: string): Promise<void> {
  const file = join(routerPaths().bundle, "Contents", "Info.plist");
  await fs.mkdir(join(routerPaths().bundle, "Contents"), { recursive: true });
  await fs.writeFile(file, contents);
}

async function writeFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

function mockFailedNativeInstall(restoreFails = false): void {
  setPlatform("darwin");
  vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
  execFileMock.mockImplementation((file: string, args: string[], optionsOrCallback, callback?: ExecCallback) => {
    const done = typeof optionsOrCallback === "function" ? optionsOrCallback as ExecCallback : callback!;
    if (file === "/usr/bin/swiftc") {
      const destination = args[args.indexOf("-o") + 1]!;
      void fs.writeFile(destination, "fake compiled helper").then(() => done(null, "", ""), (error) => done(error, "", ""));
    } else if (args[0] === "--handler") {
      done(null, "org.example.previous", "");
    } else if (args[0] === "bootstrap") {
      done(new Error("launch agent bootstrap failed"), "", "");
    } else if (restoreFails && args[0] === "--register" && args[1] === "org.example.previous") {
      done(new Error("handler restore failed"), "", "");
    } else done(null, "", "");
  });
}

describe("callback router paths and bundle metadata", () => {
  it("uses configured application and LaunchAgent directories", () => {
    const paths = routerPaths();
    expect(paths.bundle).toBe(join(appsDir, "Codex Multi Callback Router.app"));
    expect(paths.agent).toBe(join(agentsDir, `${paths.id}.plist`));
    expect(paths.state).toContain(stateRoot);
    expect(paths.id).not.toBe("");
  });

  it("marks the router bundle with manager ownership and escapes XML values", async () => {
    const { id } = routerPaths();
    const profiles = join(stateRoot, "profiles.json");
    await writeBundlePlist(routerPlist(stateRoot, profiles, id));
    const values = await readPlistValues(join(routerPaths().bundle, "Contents", "Info.plist"));
    expect(values.CodexMultiRouter).toBe("1");
    expect(values.CodexMultiRoot).toBe(stateRoot);
    expect(values.CFBundleIdentifier).toBe(id);
    expect(values.CodexMultiProfilesFile).toBe(profiles);
    expect(values.CodexMultiSlug).toBeUndefined();
  });

  it("escapes helper binary paths in LaunchAgent metadata", async () => {
    const { id, agent } = routerPaths();
    const binary = join(root, "bin", "helper & 'quotes' <special>");
    const plist = routerAgentPlist(binary, id);
    expect(plist).toContain("&amp;");
    expect(plist).toContain("&lt;special&gt;");
    await writeFile(agent, plist);
    expect((await readPlistValues(agent)).Label).toBe(id);
  });
});

describe("callback router enable and disable", () => {
  it("creates an owned router bundle, LaunchAgent, and enabled state", async () => {
    await callbackRouter("enable");
    expect(execFileMock).not.toHaveBeenCalled();
    const { bundle, agent, state, id } = routerPaths();
    const values = await readPlistValues(join(bundle, "Contents", "Info.plist"));
    expect(values).toMatchObject({
      CFBundleIdentifier: id, CodexMultiRouter: "1", CodexMultiRoot: stateRoot,
    });
    expect((await fs.stat(agent)).isFile()).toBe(true);
    expect(JSON.parse(await fs.readFile(state, "utf8"))).toMatchObject({
      enabled: true, previousHandler: "com.openai.codex", bundle, id,
    });
  });

  it("can enable an existing owned router repeatedly", async () => {
    await callbackRouter("enable");
    const paths = routerPaths();
    await expect(callbackRouter("enable")).resolves.toBeUndefined();
    expect(routerPaths()).toEqual(paths);
    expect(await fs.readdir(appsDir)).toEqual(["Codex Multi Callback Router.app"]);
    expect(await fs.readdir(agentsDir)).toEqual([`${paths.id}.plist`]);
    expect(JSON.parse(await fs.readFile(paths.state, "utf8")).enabled).toBe(true);
  });

  it("removes owned installation files and can disable repeatedly", async () => {
    await callbackRouter("enable");
    const { bundle, agent } = routerPaths();
    await callbackRouter("disable");
    await expect(fs.access(bundle)).rejects.toThrow();
    await expect(fs.access(agent)).rejects.toThrow();
    await expect(callbackRouter("disable")).resolves.toBeUndefined();
  });

  it("can disable after an owned bundle is deleted, removing temporary recovery files", async () => {
    await callbackRouter("enable");
    const { bundle, agent, state } = routerPaths();
    await fs.rm(bundle, { recursive: true });
    await expect(callbackRouter("disable")).resolves.toBeUndefined();
    await expect(fs.access(agent)).rejects.toThrow();
    await expect(fs.access(state)).rejects.toThrow();
    expect(await fs.readdir(dirname(state))).toEqual([]);
  });

  it("reports off before enable and enabled after installation", async () => {
    await callbackRouter("status");
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toMatch(/off/i);
    vi.mocked(console.log).mockClear();
    await callbackRouter("enable");
    vi.mocked(console.log).mockClear();
    await callbackRouter("status");
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toMatch(/enabled/i);
  });

  it("rejects unknown commands without creating installation files", async () => {
    await expect(callbackRouter("unexpected-command")).rejects.toThrow();
    await expect(fs.access(routerPaths().bundle)).rejects.toThrow();
    await expect(fs.access(routerPaths().agent)).rejects.toThrow();
  });
});

describe("callback router ownership checks", () => {
  it("preserves a foreign bundle at the router destination", async () => {
    const foreign = "<plist><dict><key>CFBundleIdentifier</key><string>org.example.foreign</string></dict></plist>";
    await writeBundlePlist(foreign);
    await expect(callbackRouter("enable")).rejects.toThrow();
    expect(await fs.readFile(join(routerPaths().bundle, "Contents", "Info.plist"), "utf8")).toBe(foreign);
    await expect(fs.access(routerPaths().agent)).rejects.toThrow();
  });

  it("refuses a router ownership marker belonging to another root", async () => {
    const { id, bundle } = routerPaths();
    const foreign = routerPlist(join(root, "other-state"), join(root, "other-profiles"), id);
    await writeBundlePlist(foreign);
    await expect(callbackRouter("enable")).rejects.toThrow();
    expect(await fs.readFile(join(bundle, "Contents", "Info.plist"), "utf8")).toBe(foreign);
  });

  it("preserves a foreign LaunchAgent instead of overwriting it", async () => {
    const foreign = "<plist><dict><key>Label</key><string>org.example.foreign</string></dict></plist>";
    await writeFile(routerPaths().agent, foreign);
    await expect(callbackRouter("enable")).rejects.toThrow();
    expect(await fs.readFile(routerPaths().agent, "utf8")).toBe(foreign);
  });

  it("fails closed on malformed saved state and preserves it", async () => {
    const malformed = "{ this is not JSON";
    await writeFile(routerPaths().state, malformed);
    await expect(callbackRouter("enable")).rejects.toThrow();
    expect(await fs.readFile(routerPaths().state, "utf8")).toBe(malformed);
    await expect(fs.access(routerPaths().bundle)).rejects.toThrow();
    await expect(fs.access(routerPaths().agent)).rejects.toThrow();
  });

  it("rejects valid JSON belonging to another router without overwriting it", async () => {
    const foreign = JSON.stringify({
      enabled: true, previousHandler: "org.example.previous", id: "org.example.other-router",
      bundle: join(root, "Other Router.app"),
    });
    await writeFile(routerPaths().state, foreign);
    await expect(callbackRouter("enable")).rejects.toThrow(/invalid callback router state/);
    expect(await fs.readFile(routerPaths().state, "utf8")).toBe(foreign);
    await expect(fs.access(routerPaths().bundle)).rejects.toThrow();
  });

  it.each([undefined, null, 123, true, "", "invalid handler"])(
    "rejects a saved state with invalid previous handler %s",
    async (previousHandler) => {
      const { id, bundle, state } = routerPaths();
      const malformed = JSON.stringify({ enabled: true, previousHandler, id, bundle });
      await writeFile(state, malformed);
      await expect(callbackRouter("enable")).rejects.toThrow(/invalid callback router state/);
      expect(await fs.readFile(state, "utf8")).toBe(malformed);
      await expect(fs.access(bundle)).rejects.toThrow();
    },
  );

  it("does not adopt unrecorded owned bundles after an interrupted install", async () => {
    const { id, bundle } = routerPaths();
    const owned = routerPlist(stateRoot, join(stateRoot, "profiles.json"), id);
    await writeBundlePlist(owned);
    await expect(callbackRouter("enable")).rejects.toThrow(/files exist without state/);
    expect(await fs.readFile(join(bundle, "Contents", "Info.plist"), "utf8")).toBe(owned);
    await expect(fs.access(routerPaths().state)).rejects.toThrow();
  });

  it("does not remove a foreign bundle during disable", async () => {
    await callbackRouter("enable");
    const foreign = "<plist><dict><key>CFBundleIdentifier</key><string>org.example.foreign</string></dict></plist>";
    await writeBundlePlist(foreign);
    await expect(callbackRouter("disable")).rejects.toThrow();
    expect(await fs.readFile(join(routerPaths().bundle, "Contents", "Info.plist"), "utf8")).toBe(foreign);
  });
});

describe("optional callback router launch hook", () => {
  it("does nothing when the router is not enabled", async () => {
    await expect(ensureCallbackRouterHandler()).resolves.toBeUndefined();
    await expect(fs.access(routerPaths().state)).rejects.toThrow();
    await expect(fs.access(routerPaths().bundle)).rejects.toThrow();
    await expect(fs.access(routerPaths().agent)).rejects.toThrow();
  });

  it("can refresh an enabled router without replacing its profile state", async () => {
    await callbackRouter("enable");
    const before = await fs.readFile(routerPaths().state, "utf8");
    await expect(ensureCallbackRouterHandler()).resolves.toBeUndefined();
    expect(await fs.readFile(routerPaths().state, "utf8")).toBe(before);
  });

  it("fails closed if the enabled router bundle has been removed", async () => {
    await callbackRouter("enable");
    await fs.rm(routerPaths().bundle, { recursive: true });
    await expect(ensureCallbackRouterHandler()).rejects.toThrow(/bundle is missing or foreign/);
  });

  it.each(["linux", "win32"] as const)("is a no-op on %s without the test harness", async (platform) => {
    setPlatform(platform);
    vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
    await writeFile(routerPaths().state, "{malformed");
    await expect(ensureCallbackRouterHandler()).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
    await expect(callbackRouter("enable")).rejects.toThrow(/only supported on macOS/);
  });
});

describe("callback router native handler registration", () => {
  it.each([
    ["org.example.previous", "enabled but inactive"],
    ["router", "enabled and active"],
  ])("reports native handler %s as %s without changing the association", async (handler, message) => {
    await callbackRouter("enable");
    const { id } = routerPaths();
    setPlatform("darwin");
    vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
    vi.mocked(console.log).mockClear();
    execFileMock.mockImplementation((_file, args: string[], _options, callback: ExecCallback) => {
      callback(null, args[0] === "--handler" ? handler === "router" ? id : handler : "", "");
    });
    await callbackRouter("status");
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain(message);
    expect(execFileMock.mock.calls.some((call) => (call[1] as string[])[0] === "--register")).toBe(false);
    expect(execFileMock.mock.calls.some((call) => call[0] === "/usr/bin/open")).toBe(false);
  });

  it("registers the enabled owned helper using argument arrays", async () => {
    await callbackRouter("enable");
    setPlatform("darwin");
    vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
    await ensureCallbackRouterHandler();
    const { bundle, id } = routerPaths();
    expect(execFileMock).toHaveBeenCalledWith(
      join(bundle, "Contents", "MacOS", "callback-router"), ["--register", id],
      expect.objectContaining({ maxBuffer: 1024 * 1024, timeout: 40_000 }), expect.any(Function),
    );
  });

  it("retries an unchanged association through its owned app identity and verifies the result", async () => {
    await callbackRouter("enable");
    const { bundle, id } = routerPaths();
    setPlatform("darwin");
    vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
    let opened = false;
    execFileMock.mockImplementation((file: string, args: string[], _options, callback: ExecCallback) => {
      if (file === "/usr/bin/open") {
        opened = true;
        callback(null, "", "");
      } else if (args[0] === "--register") {
        callback(new Error("handler-unchanged"), "", "");
      } else callback(null, args[0] === "--handler" && opened ? id : "org.example.previous", "");
    });
    await expect(ensureCallbackRouterHandler()).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledWith(
      "/usr/bin/open", ["-W", "-n", bundle, "--args", "--register", id],
      expect.objectContaining({ maxBuffer: 1024 * 1024, timeout: 45_000 }), expect.any(Function),
    );
    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      ["--register", id], ["-W", "-n", bundle, "--args", "--register", id], ["--handler"],
    ]);
  });

  it("rejects the fallback when the native getter still reports the previous handler", async () => {
    await callbackRouter("enable");
    setPlatform("darwin");
    vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
    execFileMock.mockImplementation((_file, args: string[], _options, callback: ExecCallback) => {
      callback(args[0] === "--register" ? new Error("handler-unchanged") : null, "org.example.previous", "");
    });
    await expect(ensureCallbackRouterHandler()).rejects.toThrow("handler-unchanged");
    expect(execFileMock.mock.calls.filter((call) => call[0] === "/usr/bin/open")).toHaveLength(1);
  });

  it.each(["consent denied", "request timed out", "unexpected helper error"])(
    "does not launch a fallback app after %s",
    async (message) => {
      await callbackRouter("enable");
      setPlatform("darwin");
      vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
      execFileMock.mockImplementation((_file, _args, _options, callback: ExecCallback) => {
        callback(new Error(message), "", "");
      });
      await expect(ensureCallbackRouterHandler()).rejects.toThrow(message);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock.mock.calls.some((call) => call[0] === "/usr/bin/open")).toBe(false);
    },
  );

  it("restores the previous handler only when this router remains the handler", async () => {
    await callbackRouter("enable");
    const { bundle, id } = routerPaths();
    setPlatform("darwin");
    vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
    execFileMock.mockImplementation((_file, args: string[], optionsOrCallback, callback?: ExecCallback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback as ExecCallback : callback!;
      done(null, args[0] === "--handler" ? id : "", "");
    });
    await callbackRouter("disable");
    expect(execFileMock).toHaveBeenCalledWith(
      join(bundle, "Contents", "MacOS", "callback-router"), ["--register", "com.openai.codex"],
      expect.objectContaining({ maxBuffer: 1024 * 1024 }), expect.any(Function),
    );
  });

  it("preserves a handler selected by another application after router enable", async () => {
    await callbackRouter("enable");
    setPlatform("darwin");
    vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
    execFileMock.mockImplementation((_file, args: string[], optionsOrCallback, callback?: ExecCallback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback as ExecCallback : callback!;
      done(null, args[0] === "--handler" ? "org.example.other-app" : "", "");
    });
    await callbackRouter("disable");
    expect(execFileMock.mock.calls.some((call) => (call[1] as string[])[0] === "--register")).toBe(false);
  });

  it("restores the previous handler and removes owned files after an install failure", async () => {
    mockFailedNativeInstall();
    await expect(callbackRouter("enable")).rejects.toThrow("launch agent bootstrap failed");
    const { bundle, agent, state } = routerPaths();
    expect(execFileMock).toHaveBeenCalledWith(
      join(bundle, "Contents", "MacOS", "callback-router"), ["--register", "org.example.previous"],
      expect.objectContaining({ maxBuffer: 1024 * 1024 }), expect.any(Function),
    );
    await expect(fs.access(bundle)).rejects.toThrow();
    await expect(fs.access(agent)).rejects.toThrow();
    await expect(fs.access(state)).rejects.toThrow();
    expect(await fs.readdir(appsDir)).toEqual([]);
  });

  it("preserves the helper and recovery state if restoring the handler fails", async () => {
    mockFailedNativeInstall(true);
    await expect(callbackRouter("enable")).rejects.toThrow(/preserved recovery state and helper/);
    const { bundle, state, id } = routerPaths();
    expect(JSON.parse(await fs.readFile(state, "utf8"))).toMatchObject({
      enabled: true, previousHandler: "org.example.previous", bundle, id,
    });
    expect(await fs.readFile(join(bundle, "Contents", "MacOS", "callback-router"), "utf8")).toBe("fake compiled helper");
    expect(await fs.readdir(appsDir)).toEqual(["Codex Multi Callback Router.app"]);
  });

  it.each(["arm64", "x64"])("compiles %s helpers for the supported macOS 12 target", async (arch) => {
    Object.defineProperty(process, "arch", { ...originalArch, value: arch });
    mockFailedNativeInstall();
    await expect(callbackRouter("enable")).rejects.toThrow("launch agent bootstrap failed");
    const compileCall = execFileMock.mock.calls.find((call) => call[0] === "/usr/bin/swiftc");
    expect(compileCall).toBeDefined();
    const args = compileCall![1] as string[];
    expect(compileCall![2]).toEqual(expect.objectContaining({ timeout: 40_000 }));
    expect(args[args.indexOf("-target") + 1]).toBe(`${arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx12.0`);
    expect(args).toEqual(expect.arrayContaining(["-framework", "AppKit", "CoreServices"]));
  });

  it("preserves installation files when the launch agent cannot be stopped", async () => {
    await callbackRouter("enable");
    const { bundle, agent, state } = routerPaths();
    const before = await fs.readFile(state, "utf8");
    setPlatform("darwin");
    vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
    execFileMock.mockImplementation((_file, args: string[], optionsOrCallback, callback?: ExecCallback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback as ExecCallback : callback!;
      done(args[0] === "bootout" ? new Error("launch agent cannot be stopped") : null, "", "");
    });
    await expect(callbackRouter("disable")).rejects.toThrow("launch agent cannot be stopped");
    expect(await fs.readFile(state, "utf8")).toBe(before);
    expect((await fs.stat(bundle)).isDirectory()).toBe(true);
    expect((await fs.stat(agent)).isFile()).toBe(true);
    expect(execFileMock.mock.calls.some((call) => (call[1] as string[])[0] === "--register")).toBe(false);
  });
});
