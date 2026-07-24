import { afterEach, describe, expect, it, vi } from "vitest";

process.env.CODEX_MULTI_NO_AUTO_RUN = "1";
const { main, parseFlags } = await import("../src/cli.ts");

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(log).toHaveBeenCalledWith("0.2.1");
  });
});
