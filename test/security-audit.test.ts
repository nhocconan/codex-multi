import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
let root: string;

beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "cpm-security-audit-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("atomic write source audit", () => {
  it("rejects write-then-rename replacements with an actionable location", async () => {
    await fs.writeFile(join(root, "unsafe.ts"), 'async function save() {\n await fs.writeFile(staging, content);\n await fs.rename(staging, destination);\n}\n');
    await expect(exec(process.execPath, [resolve("scripts/audit/atomic-writes.mjs"), root])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unsafe.ts:2: unsafe temporary write; use atomicWrite()"),
    });
  });

  it("allows the shared writer and writes inside a staged bundle", async () => {
    await fs.writeFile(join(root, "safe.ts"), 'async function save() {\n await atomicWrite(destination, content);\n await fs.writeFile(executable, script);\n await fs.rename(stage, bundle);\n}\n');
    const result = await exec(process.execPath, [resolve("scripts/audit/atomic-writes.mjs"), root]);
    expect(result.stdout).toContain("Atomic write audit passed.");
  });
});
