import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  authFingerprint,
  authPath,
  copyCurrentAuth,
  inspectAuth,
} from "../src/core/auth.ts";

let root = "";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-auth-"));
  process.env.CODEX_PROFILE_MANAGER_BASE_HOME = join(root, "base");
  process.env.CODEX_PROFILE_MANAGER_HOME = join(root, "manager");
  await fs.mkdir(join(root, "base"), { recursive: true });
});

afterEach(async () => {
  delete process.env.CODEX_PROFILE_MANAGER_BASE_HOME;
  delete process.env.CODEX_PROFILE_MANAGER_HOME;
  await fs.rm(root, { recursive: true, force: true });
});

describe("auth isolation", () => {
  it("imports current file auth and exposes only safe summary fields", async () => {
    const auth = {
      auth_mode: "chatgpt",
      tokens: {
        id_token: jwt({
          "https://api.openai.com/profile": { email: "person@example.com" },
          "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
        }),
        access_token: "secret-access",
        refresh_token: "secret-refresh",
      },
    };
    await fs.writeFile(join(root, "base", "auth.json"), JSON.stringify(auth));
    await copyCurrentAuth("personal");
    const summary = await inspectAuth("personal");
    expect(summary).toEqual({
      ok: true,
      mode: "chatgpt",
      identity: "person@example.com",
      plan: "pro",
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(await authFingerprint("personal")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts API-key auth without revealing the key", async () => {
    await fs.mkdir(join(root, "manager", "profiles", "api"), { recursive: true });
    await fs.writeFile(
      authPath("api"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-private" }),
    );
    expect(await inspectAuth("api")).toEqual({ ok: true, mode: "apikey" });
  });

  it("uses a stable account identifier for duplicate detection", async () => {
    for (const [slug, lastRefresh, accessToken] of [
      ["one", "2026-01-01T00:00:00Z", "access-one"],
      ["two", "2026-07-01T00:00:00Z", "access-two"],
    ] as const) {
      await fs.mkdir(join(root, "manager", "profiles", slug), { recursive: true });
      await fs.writeFile(
        authPath(slug),
        JSON.stringify({
          auth_mode: "chatgpt",
          last_refresh: lastRefresh,
          tokens: {
            account_id: "account-123",
            access_token: accessToken,
            refresh_token: `refresh-${slug}`,
          },
        }),
      );
    }
    expect(await authFingerprint("one")).toBe(await authFingerprint("two"));
  });

  it("reports missing and credential-free auth files", async () => {
    expect((await inspectAuth("missing")).ok).toBe(false);
    await fs.mkdir(join(root, "manager", "profiles", "empty"), { recursive: true });
    await fs.writeFile(authPath("empty"), '{"auth_mode":"chatgpt"}');
    expect(await inspectAuth("empty")).toMatchObject({
      ok: false,
      problem: "auth.json contains no usable credential",
    });
  });
});
