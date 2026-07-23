import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withFileLock } from "../src/core/lock.ts";

let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-lock-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("cross-process file lock", () => {
  it("serializes concurrent operations", async () => {
    const lock = join(root, "registry.lock");
    let active = 0;
    let maximumActive = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFileLock(lock, async () => {
          active++;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
        }),
      ),
    );
    expect(maximumActive).toBe(1);
  });

  it("recovers a lock left by a dead process", async () => {
    const lock = join(root, "stale.lock");
    const lockDirectory = `${lock}.lock`;
    await fs.mkdir(lockDirectory);
    const staleTime = new Date(Date.now() - 20_000);
    await fs.utimes(lockDirectory, staleTime, staleTime);
    await expect(withFileLock(lock, async () => "recovered")).resolves.toBe("recovered");
    await expect(fs.lstat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows only one stale-lock reclaimer to enter at a time", async () => {
    const lock = join(root, "contended-stale.lock");
    const lockDirectory = `${lock}.lock`;
    await fs.mkdir(lockDirectory);
    const staleTime = new Date(Date.now() - 20_000);
    await fs.utimes(lockDirectory, staleTime, staleTime);
    let active = 0;
    let maximumActive = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withFileLock(lock, async () => {
          active++;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
        }),
      ),
    );
    expect(maximumActive).toBe(1);
  });
});
