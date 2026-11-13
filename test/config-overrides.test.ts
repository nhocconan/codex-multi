import { describe, expect, it } from "vitest";
import { assertFileCredentialStore, withFileCredentialStore } from "../src/core/config-overrides.ts";

describe("managed credential-store overrides", () => {
  it("pins the override at the root while preserving the exec payload", () => {
    const args = ["exec", "-c", 'model="test"', "--", "-c", "literal prompt"];
    expect(withFileCredentialStore(args)).toEqual([
      "-c", 'cli_auth_credentials_store="file"', "exec", "-c", 'model="test"', "--", "-c", "literal prompt",
    ]);
    expect(args).toEqual(["exec", "-c", 'model="test"', "--", "-c", "literal prompt"]);
    expect(withFileCredentialStore(["login", "status"])).toEqual([
      "-c", 'cli_auth_credentials_store="file"', "login", "status",
    ]);
    expect(withFileCredentialStore(["help", "login"])).toEqual([
      "-c", 'cli_auth_credentials_store="file"', "help", "login",
    ]);
    expect(withFileCredentialStore(["sandbox", "macos", "echo", "hello"])).toEqual([
      "-c", 'cli_auth_credentials_store="file"', "sandbox", "macos", "echo", "hello",
    ]);
  });
  it.each([
    ["-c", 'cli_auth_credentials_store="keyring"'],
    ["--config", "cli_auth_credentials_store=auto"],
    ['--config=cli_auth_credentials_store="ephemeral"'],
    ['-ccli_auth_credentials_store="keyring"'],
    ['-c=cli_auth_credentials_store="keyring"'],
    ["exec", "-c", "cli_auth_credentials_store='keyring'", "hello"],
    ["-c", '"cli_auth_credentials_store"="keyring"'],
    ["-c", '"cli_auth_credentials_stor\\u0065"="keyring"'],
    ["-c", 'profiles.work.cli_auth_credentials_store="keyring"'],
    ["-c", 'profiles={work={cli_auth_credentials_store="keyring"}}'],
    ["-c", 'cli_auth_credentials_store="file"', "-c", 'cli_auth_credentials_store="keyring"'],
    ["-c", "cli_auth_credentials_store=123"],
  ])("blocks storage overrides before Codex runs: %j", (...args) => {
    expect(() => assertFileCredentialStore(args)).toThrow('require cli_auth_credentials_store="file"');
  });

  it.each([
    ["exec", "hello"],
    ["-c", 'cli_auth_credentials_store="file"'],
    ["-c", "cli_auth_credentials_store=file"],
    ["--config=cli_auth_credentials_store='file'"],
    ["-c", "model=gpt-test", "exec", "hello"],
    ["-c", 'mcp_servers.example.env={API_KEY="fake-test"}'],
    ["exec", "--", "-c", 'cli_auth_credentials_store="keyring"'],
    ["-c", 'instructions="cli_auth_credentials_store=keyring"'],
    ["-c"],
  ])("preserves normal Codex arguments and literal prompts: %j", (...args) => {
    expect(() => assertFileCredentialStore(args)).not.toThrow();
  });

  it("does not include override values in errors", () => {
    expect(() => assertFileCredentialStore(["-c", 'cli_auth_credentials_store="fake-sensitive-value"']))
      .toThrow(expect.not.stringContaining("fake-sensitive-value"));
  });
});
