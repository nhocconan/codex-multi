import { describe, expect, it } from "vitest";

process.env.CODEX_PROFILE_MANAGER_NO_AUTO_RUN = "1";
const { parseFlags } = await import("../src/cli.ts");

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
});
