import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  // Preserve execFile's custom promisified result while mocking its callback API.
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
  assertDesktopStopped,
  desktopPidsFromPs,
  runningDesktopPids,
  waitForDesktopStartup,
} from "../src/core/desktop-runtime.ts";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const root = join(tmpdir(), "cpm-desktop-runtime-fixture", "state 'quotes'");
const dataDir = join(root, "desktop", "work");
// ps output describes a macOS process even when these tests run on Windows.
const appExecutable = posix.join("/", "Fixtures", "Chat GPT.app", "Contents", "MacOS", "ChatGPT");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
}

function processLine(pid: number, dir = dataDir, extra = ""): string {
  return `  ${pid} ${appExecutable} --user-data-dir=${dir}${extra}`;
}

function replyWith(stdout: string): void {
  execFileMock.mockImplementationOnce((_file, _args, _options, callback: ExecCallback) => {
    callback(null, stdout, "");
  });
}

beforeEach(() => {
  setPlatform("darwin");
  vi.stubEnv("CODEX_MULTI_HOME", root);
  vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", undefined);
  execFileMock.mockReset();
  execFileMock.mockImplementation((_file, _args, _options, callback: ExecCallback) => {
    callback(null, "", "");
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("desktopPidsFromPs", () => {
  it("matches exact profile directories containing spaces and quotes", () => {
    const output = [processLine(123), processLine(456, dataDir, " --verbose")].join("\r\n");
    expect(desktopPidsFromPs(output, dataDir)).toEqual([123, 456]);
  });

  it("excludes renderer and helper processes regardless of flag order", () => {
    const output = [
      processLine(123, dataDir, " --type=renderer"),
      `456 ${appExecutable} --type=gpu-process --user-data-dir=${dataDir}`,
      processLine(789),
    ].join("\n");
    expect(desktopPidsFromPs(output, dataDir)).toEqual([789]);
  });

  it("rejects adjacent profile slugs, directory prefixes, and partial flags", () => {
    const output = [
      processLine(1, `${dataDir}-two`),
      processLine(2, join(dataDir, "child")),
      processLine(3, `${dataDir} extra`),
      processLine(4, join(root, "desktop", "other-work")),
      `5 ${appExecutable} --other-user-data-dir=${dataDir}`,
      processLine(6),
    ].join("\n");
    expect(desktopPidsFromPs(output, dataDir)).toEqual([6]);
  });

  it("ignores malformed lines, non-app executables, and missing profile flags", () => {
    const output = [
      "", "PID COMMAND", `bad ${appExecutable} --user-data-dir=${dataDir}`,
      `7 ${posix.join("/", "Fixtures", "codex")} --user-data-dir=${dataDir}`,
      `8 ${appExecutable}`,
    ].join("\n");
    expect(desktopPidsFromPs(output, dataDir)).toEqual([]);
  });
});

describe("runningDesktopPids", () => {
  it("scans macOS processes through execFile and selects the requested profile", async () => {
    replyWith([processLine(123), processLine(456, join(root, "desktop", "personal"))].join("\n"));
    await expect(runningDesktopPids("work")).resolves.toEqual([123]);
    expect(execFileMock).toHaveBeenCalledWith(
      "/bin/ps", ["-axo", "pid=,args="], { maxBuffer: 8 * 1024 * 1024 }, expect.any(Function),
    );
  });

  it.each(["linux", "win32"] as const)("does not invoke native tools on %s", async (platform) => {
    setPlatform(platform);
    await expect(runningDesktopPids("work")).resolves.toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not invoke native tools when explicitly disabled", async () => {
    vi.stubEnv("CODEX_MULTI_NO_NATIVE_TOOLS", "1");
    await expect(runningDesktopPids("work")).resolves.toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("preserves a failed scan as an error instead of reporting no processes", async () => {
    const cause = new Error("process listing unavailable");
    execFileMock.mockImplementationOnce((_file, _args, _options, callback: ExecCallback) => {
      callback(cause, "", "");
    });
    await expect(runningDesktopPids("work")).rejects.toMatchObject({
      message: "could not check running desktop profiles: process listing unavailable", cause,
    });
  });
});

describe("assertDesktopStopped", () => {
  it("allows a stopped profile when another profile is running", async () => {
    replyWith(processLine(123, join(root, "desktop", "personal")));
    await expect(assertDesktopStopped("work")).resolves.toBeUndefined();
  });

  it("blocks mutations when the requested profile is running", async () => {
    replyWith(processLine(123));
    await expect(assertDesktopStopped("work")).rejects.toThrow(
      /desktop profile work is running; quit its desktop app/,
    );
  });

  it("fails closed when the process scan fails", async () => {
    execFileMock.mockImplementationOnce((_file, _args, _options, callback: ExecCallback) => {
      callback(new Error("permission denied"), "", "");
    });
    await expect(assertDesktopStopped("work")).rejects.toThrow(
      "could not check running desktop profiles: permission denied",
    );
  });
});

describe("waitForDesktopStartup", () => {
  it("returns immediately when the profile is already running", async () => {
    vi.useFakeTimers();
    replyWith(processLine(123));
    await expect(waitForDesktopStartup("work")).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries until the requested profile starts", async () => {
    vi.useFakeTimers();
    replyWith(processLine(456, join(root, "desktop", "personal")));
    replyWith(processLine(123));
    const startup = waitForDesktopStartup("work");
    await vi.advanceTimersByTimeAsync(100);
    await expect(startup).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a timeout after the bounded startup polling window", async () => {
    vi.useFakeTimers();
    const rejection = expect(waitForDesktopStartup("work")).rejects.toThrow(
      "desktop profile work did not start; check the desktop app and try again",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
    expect(execFileMock).toHaveBeenCalledTimes(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates scan errors without waiting through the polling window", async () => {
    vi.useFakeTimers();
    execFileMock.mockImplementationOnce((_file, _args, _options, callback: ExecCallback) => {
      callback(new Error("scan failed"), "", "");
    });
    await expect(waitForDesktopStartup("work")).rejects.toThrow(
      "could not check running desktop profiles: scan failed",
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
