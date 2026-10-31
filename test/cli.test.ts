import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/version.ts";

const { resetPendingMock } = vi.hoisted(() => ({ resetPendingMock: vi.fn() }));
vi.mock("../src/commands/desktop.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/commands/desktop.ts")>(),
  resetPendingDesktop: resetPendingMock,
}));

process.env.CODEX_MULTI_NO_AUTO_RUN = "1";
const { main, parseFlags } = await import("../src/cli.ts");

afterEach(() => {
  vi.restoreAllMocks();
  resetPendingMock.mockReset();
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
