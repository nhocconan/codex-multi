import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/version.ts";

const { resetPendingMock, addMock, editMock, launchMock, removeMock, loginMock } = vi.hoisted(() => ({
  resetPendingMock: vi.fn(), addMock: vi.fn(), editMock: vi.fn(), launchMock: vi.fn(), removeMock: vi.fn(), loginMock: vi.fn(),
}));
vi.mock("../src/commands/add.ts", () => ({ add: addMock }));
vi.mock("../src/commands/edit.ts", () => ({ edit: editMock }));
vi.mock("../src/commands/launch.ts", () => ({ launch: launchMock }));
vi.mock("../src/commands/remove.ts", () => ({ remove: removeMock }));
vi.mock("../src/commands/login.ts", () => ({ login: loginMock }));
vi.mock("../src/commands/desktop.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/commands/desktop.ts")>(),
  resetPendingDesktop: resetPendingMock,
}));

process.env.CODEX_MULTI_NO_AUTO_RUN = "1";
const { main, parseFlags } = await import("../src/cli.ts");

afterEach(() => {
  vi.restoreAllMocks();
  resetPendingMock.mockReset();
  for (const mock of [addMock, editMock, launchMock, removeMock, loginMock]) mock.mockReset();
});

describe("CLI flag parser", () => {
  it("parses values, booleans, short flags, and positionals", () => {
    const flags = parseFlags([
      "personal",
      "--name",
      "Personal",
      "-s=home",
      "--device-auth",
      "--yes",
    ]);
    expect(flags.positionals).toEqual(["personal"]);
    expect(flags.values.get("name")).toBe("Personal");
    expect(flags.values.get("s")).toBe("home");
    expect(flags.booleans.has("device-auth")).toBe(true);
    expect(flags.booleans.has("yes")).toBe(true);
  });

  it("stops parsing at the passthrough separator", () => {
    expect(parseFlags(["work", "--", "--model", "gpt-test"]).positionals).toEqual([
      "work",
      "--model",
      "gpt-test",
    ]);
  });

  it.each([
    [["--nmae", "Work"], "unknown option"],
    [["--yes=false"], "does not take a value"],
    [["--desktop=true"], "does not take a value"],
    [["--name"], "missing value"],
    [["--slug="], "missing value"],
    [["--name", ""], "missing value"],
    [["--name", "Work", "-n", "Personal"], "duplicate option"],
    [["--yes", "-y"], "duplicate option"],
  ])("rejects ambiguous or invalid flags %j", (args, problem) => {
    expect(() => parseFlags(args)).toThrow(problem);
  });

  it("does not include an unknown option's value in error messages", () => {
    expect(() => parseFlags(["--api-key=fake-sensitive-value"]))
      .toThrow("unknown option: --api-key");
    try { parseFlags(["--api-key=fake-sensitive-value"]); }
    catch (error) { expect(String(error)).not.toContain("fake-sensitive-value"); }
  });

  it.each([
    ["remove", "work", "--yes", "personal"],
    ["remove", "work", "--desktop"],
    ["desktop-reset-pending", "work", "--confirm-quit", "personal"],
    ["sync", "--yes"],
    ["list", "work"],
    ["add", "work"],
    ["callback-router", "enable", "extra"],
  ])("rejects invalid manager command before performing it: %j", async (...args) => {
    await expect(main(["node", "cpm", ...args])).rejects.toThrow();
    expect(removeMock).not.toHaveBeenCalled();
    expect(resetPendingMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it.each([
    ["add", "--device-auth", "--api-key-env", "API_KEY"],
    ["add", "--api-key-env", "API_KEY", "--access-token-env", "ACCESS"],
    ["add", "--import-current", "--device-auth"],
    ["import", "--api-key-env", "API_KEY"],
    ["login", "work", "--device-auth", "--access-token-env", "ACCESS"],
    ["add", "--desktop-name", "Codex Work"],
    ["add", "--desktop-color", "blue"],
  ])("rejects conflicting or ineffective options before mutation: %j", async (...args) => {
    await expect(main(["node", "cpm", ...args])).rejects.toThrow();
    expect(addMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("shows help for mutation commands without performing them", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(main(["node", "cpm", "remove", "work", "--yes", "--help"])).resolves.toBe(0);
    await expect(main(["node", "cpm", "add", "--help"])).resolves.toBe(0);
    expect(removeMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it("shows help with no command in a noninteractive terminal", async () => {
    vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: false } as typeof process.stdin);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(main(["node", "cpm"])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Interactive picker"));
  });

  it("passes profile CLI arguments through without parsing manager options", async () => {
    launchMock.mockResolvedValue(7);
    await expect(main(["node", "cpm", "launch", "work", "--", "--unknown-codex-flag", "--help"]))
      .resolves.toBe(7);
    expect(launchMock).toHaveBeenCalledWith("work", ["--", "--unknown-codex-flag", "--help"]);
    await expect(main(["node", "codex-work", "--help"])).resolves.toBe(7);
    expect(launchMock).toHaveBeenLastCalledWith("work", ["--help"]);
  });

  it("keeps supported short options and empty desktop-name resets", async () => {
    await main(["node", "cpm", "add", "-n", "Work", "-s", "work", "--device-auth", "--separated"]);
    expect(addMock).toHaveBeenCalledWith({ name: "Work", slug: "work", deviceAuth: true, separated: true });
    await main(["node", "cpm", "edit", "work", "--desktop-name="]);
    expect(editMock).toHaveBeenCalledWith("work", { desktopName: "" });
  });

  it.each(["toString", "__proto__", "constructor"])("reports %s as an unknown command", async (command) => {
    await expect(main(["node", "cpm", command])).rejects.toThrow("unknown command");
  });

  it("treats the codex-multi binary as the manager, not a profile launcher", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["node", "codex-multi", "--version"])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(VERSION);
  });

  it("passes only explicit quit acknowledgment to pending-launch recovery", async () => {
    await main(["node", "cpm", "desktop-reset-pending", "work"]);
    expect(resetPendingMock).toHaveBeenLastCalledWith("work", false);
    await main(["node", "cpm", "desktop-reset-pending", "work", "--confirm-quit"]);
    expect(resetPendingMock).toHaveBeenLastCalledWith("work", true);
    await expect(main(["node", "cpm", "desktop-reset-pending"])).rejects.toThrow("usage:");
  });
});
