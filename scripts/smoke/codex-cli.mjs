import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "cpm-native-cli-"));
const manager = resolve("dist/cli.js");
const base = join(root, "base");
const state = join(root, "manager");
const home = join(state, "profiles", "smoke");
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  XDG_CONFIG_HOME: join(root, "config"),
  CODEX_HOME: base,
  CODEX_MULTI_HOME: state,
  CODEX_MULTI_BASE_HOME: base,
  CODEX_MULTI_PROFILES_DIR: join(state, "profiles"),
  CODEX_MULTI_PROFILES_FILE: join(state, "profiles.json"),
  CODEX_MULTI_BIN_DIR: join(root, "bin"),
  CODEX_MULTI_APPS_DIR: join(root, "Applications"),
  CODEX_MULTI_NO_NATIVE_TOOLS: "1",
};

try {
  await mkdir(base, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(base, "config.toml"), 'cli_auth_credentials_store="ephemeral"\n');
  await writeFile(join(base, "work.config.toml"), 'cli_auth_credentials_store="ephemeral"\n');
  await writeFile(join(home, "auth.json"), '{"OPENAI_API_KEY":"fake-native-smoke-key"}', { mode: 0o600 });
  await writeFile(join(state, "profiles.json"), JSON.stringify([
    { slug: "smoke", label: "Smoke", createdAt: new Date().toISOString() },
  ]));

  const cases = [
    ["login", "status"],
    ["-c", 'model="gpt-test"', "login", "status"],
    ["exec", "--help"],
    ["--profile", "work", "exec", "--help"],
    ["--help"],
    ["help", "login"],
    ["completion", "bash"],
  ];
  let configBefore;
  for (const args of cases) {
    const result = await exec(process.execPath, [manager, "launch", "smoke", "--", ...args], {
      cwd: root, env, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    const output = result.stdout + result.stderr;
    if (args.includes("status")) assert.match(output, /(?:API key configured|Logged in.*API key)/i);
    const config = await stat(join(home, "config.toml"), { bigint: true });
    if (configBefore) {
      assert.equal(config.ino, configBefore.ino, "unchanged config was replaced");
      assert.equal(config.mtimeNs, configBefore.mtimeNs, "unchanged config was rewritten");
    }
    configBefore = config;
    console.log(`PASS ${args.join(" ")}`);
  }
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"OPENAI_API_KEY":"fake-native-smoke-key"}');
  console.log("Native CLI smoke passed; synthetic auth unchanged; repeated config replacements: 0.");
} catch (error) {
  // Subprocess error objects can include authentication output; report status only.
  if (error?.code) throw new Error(`native CLI smoke failed (${error.code}); check CODEX_MULTI_CODEX_BIN and rebuild`);
  throw new Error(error instanceof assert.AssertionError ? error.message : "native CLI smoke failed");
} finally {
  await rm(root, { recursive: true, force: true });
}
