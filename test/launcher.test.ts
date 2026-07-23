import { afterEach, describe, expect, it } from "vitest";
import { buildLaunchEnv } from "../src/core/launcher.ts";
import type { Profile } from "../src/core/registry.ts";

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_ACCESS_TOKEN;
  delete process.env.CODEX_HOME;
  delete process.env.CPM_TEST_KEEP;
});

describe("launch environment", () => {
  it("isolates CODEX_HOME and scrubs competing auth", () => {
    process.env.OPENAI_API_KEY = "wrong";
    process.env.CODEX_ACCESS_TOKEN = "wrong";
    process.env.CODEX_HOME = "/wrong";
    process.env.CPM_TEST_KEEP = "yes";
    const profile: Profile = {
      slug: "work",
      label: "Work",
      createdAt: "x",
    };
    const env = buildLaunchEnv(profile, "/isolated");
    expect(env.CODEX_HOME).toBe("/isolated");
    expect(env.CODEX_PROFILE_MANAGER_SLUG).toBe("work");
    expect(env.CODEX_PROFILE_MANAGER_LABEL).toBe("Work");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.CPM_TEST_KEEP).toBe("yes");
  });
});
