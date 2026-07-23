import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { launchersDir } from "../src/core/paths.ts";

let root = "";
let originalPath: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-paths-"));
  originalPath = process.env.PATH;
  delete process.env.CODEX_PROFILE_MANAGER_BIN_DIR;
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.CODEX_PROFILE_MANAGER_BIN_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe("launcher path selection", () => {
  it("honors an explicit launcher directory", () => {
    const explicit = join(root, "explicit");
    process.env.CODEX_PROFILE_MANAGER_BIN_DIR = explicit;
    expect(launchersDir()).toBe(explicit);
  });

  it("skips transient npx and node_modules bin directories", async () => {
    const npxBin = join(root, "_npx", "123", "node_modules", ".bin");
    const projectBin = join(root, "project", "node_modules", ".bin");
    const durableBin = join(root, "durable-bin");
    await Promise.all(
      [npxBin, projectBin, durableBin].map((directory) =>
        fs.mkdir(directory, { recursive: true }),
      ),
    );
    process.env.PATH = [npxBin, projectBin, durableBin].join(delimiter);
    expect(launchersDir()).toBe(durableBin);
  });
});
