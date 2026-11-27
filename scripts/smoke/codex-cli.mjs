import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
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
  CODEX_SQLITE_HOME: "",
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

// Drive the same stdio app-server methods used by the desktop client.
async function appServerTurn(slug, threadId) {
  const command = exec(process.execPath, [manager, "launch", slug, "--", "app-server", "--stdio"], {
    env, cwd: root, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  const { stdin, stdout } = command.child;
  const completion = command.then(() => true, () => false);
  const lines = createInterface({ input: stdout });
  const send = message => stdin.write(JSON.stringify(message) + "\n");
  let completed = false;
  try {
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "resume-smoke", version: "1" } } });
    for await (const line of lines) {
      const message = JSON.parse(line);
      assert.ok(!message.error, "app-server rejected the smoke request");
      if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "thread/resume", params: { threadId } });
      } else if (message.id === 2) {
        assert.equal(message.result.thread.id, threadId);
        send({ id: 3, method: "turn/start", params: {
          threadId, input: [{ type: "text", text: "remember app-server-marker" }],
        } });
      } else if (message.method === "turn/completed") {
        assert.equal(message.params.turn.status, "completed");
        completed = true;
        break;
      }
    }
  } finally {
    lines.close();
    stdin.end();
    await completion;
  }
  assert.ok(completed, "app-server exited before the resumed turn completed");
}

// Exercise persistent turns through the official binary with a loopback Responses provider.
async function checkResume() {
  let input;
  const server = createServer(async (req, res) => {
    if (!req.url?.endsWith("/responses")) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    input = Buffer.concat(chunks).toString();
    const events = [
      { type: "response.created", response: { id: "response-smoke" } },
      { type: "response.output_item.done", item: { id: "msg-smoke", type: "message", role: "assistant",
        content: [{ type: "output_text", text: "fixture reply" }] } },
      { type: "response.completed", response: { id: "response-smoke", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  try {
    await writeFile(join(base, "config.toml"), [
      `chatgpt_base_url = "http://127.0.0.1:${server.address().port}/backend-api"`,
      'features.cli_resume_account_check = true', 'model_provider = "fixture"',  'model = "gpt-5.4"', '[model_providers.fixture]',
      'name = "fixture"', `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'wire_api = "responses"', 'supports_websockets = false',
    ].join("\n"));
    const otherHome = join(state, "profiles", "second");
    await mkdir(otherHome, { recursive: true });
    await writeFile(join(otherHome, "auth.json"), '{"OPENAI_API_KEY":"fake-second-key"}', { mode: 0o600 });
    await writeFile(join(state, "profiles.json"), JSON.stringify(["smoke", "second"].map(slug => ({
      slug, label: slug, createdAt: new Date().toISOString(),
    }))));
    async function turn(slug, args) {
      input = undefined;
      const command = exec(process.execPath, [manager, "launch", slug, "--", "exec",
        "--json", "--skip-git-repo-check", ...args], { env, cwd: root, timeout: 30_000 });
      command.child.stdin.end();
      const { stdout } = await command.catch(error => {
        if ((error.stdout + error.stderr).includes("Sign in with the original account")) throw new Error("original account required");
        const details = (error.stdout + error.stderr);
        const reason = details.match(/no rollout found|thread not found|stream disconnected/i);
        console.error(`FAIL persistent turn for ${slug} (${reason?.[0] ?? "Codex error"})`);
        throw error;
      });
      const events = stdout.trim().split("\n").map(line => JSON.parse(line));
      assert.ok(events.some(event => event.type === "turn.completed"), "turn did not complete");
      assert.ok(input, "loopback provider received no input");
      return events.find(event => event.type === "thread.started")?.thread_id;
    }
    const id = await turn("smoke", ["remember fixture-marker-one"]);
    assert.ok(id, "first turn missing thread ID");
    assert.equal(await turn("second", ["resume", id, "continue fixture-marker-two"]), id);
    assert.match(input, /fixture-marker-one/);
    assert.match(input, /fixture reply/);
    assert.match(input, /fixture-marker-two/);
    console.log("PASS cross-profile resume with the same ID and prior turn context");

    for (const [dir, account] of [[home, "fixture-one"], [otherHome, "fixture-two"]]) {
      const claims = { "https://api.openai.com/auth": { chatgpt_user_id: account, chatgpt_account_id: account } };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      await writeFile(join(dir, "auth.json"), JSON.stringify({
        auth_mode: "chatgpt", last_refresh: new Date().toISOString(),
        tokens: { account_id: account, id_token: `eyJhbGciOiJub25lIn0.${payload}.Zml4dHVyZQ`,
          access_token: "fixture-access", refresh_token: "fixture-refresh" },
      }), { mode: 0o600 });
    }
    const owned = await turn("smoke", ["remember owner-marker"]);
    assert.ok(owned);
    await assert.rejects(turn("second", ["resume", owned, "continue"]), /original account required/);
    const fork = await turn("second", ["fork", owned, "remember fork-marker"]);
    assert.ok(fork);
    assert.notEqual(fork, owned);
    assert.match(input, /owner-marker/);
    assert.equal(await turn("second", ["resume", fork, "continue the fork"]), fork);
    assert.match(input, /fork-marker/);
    await appServerTurn("second", fork);
    assert.match(input, /fork-marker/);
    assert.equal(await turn("second", ["resume", fork, "continue after app server"]), fork);
    assert.match(input, /app-server-marker/);
    console.log("PASS CLI to app-server to CLI, including the persisted follow-up turn");
    console.log("PASS original-account check, native fork and resume under the second account");
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

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
  await checkResume();
  console.log("Native smoke passed with synthetic credentials and a loopback model provider.");
} catch (error) {
  // Subprocess error objects can include authentication output; report status only.
  if (error?.code) throw new Error(`native CLI smoke failed (${error.code}); check CODEX_MULTI_CODEX_BIN and rebuild`);
  throw new Error(error instanceof assert.AssertionError ? error.message : "native CLI smoke failed");
} finally {
  await rm(root, { recursive: true, force: true });
}
