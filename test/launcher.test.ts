import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLaunchEnv } from "../src/core/launcher.ts";
import type { Profile } from "../src/core/registry.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_ACCESS_TOKEN;
  delete process.env.CODEX_HOME;
  delete process.env.CPM_TEST_KEEP;
});

describe("launch environment", () => {
  it("scrubs case variants and desktop state while preserving custom MCP environment", () => {
    for (const key of ["openai_api_key", "codex_api_key", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_ORG_ID", "openai_project_id", "codex_access_token",
      "codex_home", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_DESKTOP_RELAUNCH_OPEN_EVENTS"]) {
      vi.stubEnv(key, "ambient");
    }
    vi.stubEnv("CPM_CUSTOM_MCP_TOKEN", "fake-custom");
    const env = buildLaunchEnv({ slug: "work", label: "Work", createdAt: "x" }, "/isolated");
    const forbidden = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "CODEX_ACCESS_TOKEN",
      "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_DESKTOP_RELAUNCH_OPEN_EVENTS"]);
    expect(Object.keys(env).filter((key) => forbidden.has(key.toUpperCase()))).toEqual([]);
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "CODEX_HOME")).toEqual(["CODEX_HOME"]);
    expect(env.CODEX_HOME).toBe("/isolated");
    expect(env.CPM_CUSTOM_MCP_TOKEN).toBe("fake-custom");
  });
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
    expect(env.CODEX_MULTI_SLUG).toBe("work");
    expect(env.CODEX_MULTI_LABEL).toBe("Work");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.CPM_TEST_KEEP).toBe("yes");
  });
});
