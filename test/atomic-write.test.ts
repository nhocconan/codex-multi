import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWrite } from "../src/core/atomic-write.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

let root: string;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-atomic-"));
});

afterEach(async () => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
  vi.mocked(randomUUID).mockReset();
  vi.mocked(randomUUID).mockImplementation((await vi.importActual<typeof import("node:crypto")>("node:crypto")).randomUUID);
  await fs.rm(root, { recursive: true, force: true });
});

describe("private atomic writes", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retries transient Windows %s replacement failures without deleting the destination", async (code) => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    const path = join(root, "registry.json");
    await fs.writeFile(path, "original");
    const rename = fs.rename.bind(fs);
    let attempts = 0;
    const replacement = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      attempts++;
      expect(await fs.readFile(path, "utf8")).toBe("original");
      if (attempts < 3) throw Object.assign(new Error("transient Windows contention"), { code });
      await rename(from, to);
    });
    const unlink = vi.spyOn(fs, "unlink");
    await atomicWrite(path, "replacement");
    expect(replacement).toHaveBeenCalledTimes(3);
    expect(unlink.mock.calls.every(([target]) => String(target) !== path)).toBe(true);
    expect(await fs.readFile(path, "utf8")).toBe("replacement");
    expect(await fs.readdir(root)).toEqual(["registry.json"]);
  });

  it("bounds retries for permanent Windows contention and preserves the destination", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    const path = join(root, "registry.json");
    await fs.writeFile(path, "original");
    const error = Object.assign(new Error("permanent contention"), { code: "EPERM" });
    const replacement = vi.spyOn(fs, "rename").mockRejectedValue(error);
    await expect(atomicWrite(path, "replacement")).rejects.toBe(error);
    expect(replacement).toHaveBeenCalledTimes(11);
    expect(await fs.readFile(path, "utf8")).toBe("original");
    expect(await fs.readdir(root)).toEqual(["registry.json"]);
  });

  it.each([["win32", "ENOSPC"], ["linux", "EPERM"], ["darwin", "EBUSY"]] as const)("does not retry %s %s failures", async (platform, code) => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    const path = join(root, "registry.json");
    await fs.writeFile(path, "original");
    const error = Object.assign(new Error("replacement denied"), { code });
    const replacement = vi.spyOn(fs, "rename").mockRejectedValue(error);
    await expect(atomicWrite(path, "replacement")).rejects.toBe(error);
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path, "utf8")).toBe("original");
    expect(await fs.readdir(root)).toEqual(["registry.json"]);
  });

  it("refuses an existing temporary file without changing or removing it", async () => {
    vi.mocked(randomUUID).mockReturnValue("00000000-0000-4000-8000-000000000000");
    const path = join(root, "auth.json");
    const temporary = `${path}.00000000-0000-4000-8000-000000000000.tmp`;
    await fs.writeFile(temporary, "foreign content");
    await expect(atomicWrite(path, "fake-new-auth")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(temporary, "utf8")).toBe("foreign content");
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow a preplanted temporary symlink", async (context) => {
    vi.mocked(randomUUID).mockReturnValue("00000000-0000-4000-8000-000000000000");
    const path = join(root, "auth.json");
    const target = join(root, "base-auth.json");
    const temporary = `${path}.00000000-0000-4000-8000-000000000000.tmp`;
    await fs.writeFile(target, "fake-base-auth");
    try {
      await fs.symlink(target, temporary);
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(atomicWrite(path, "fake-new-auth")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(target, "utf8")).toBe("fake-base-auth");
    expect((await fs.lstat(temporary)).isSymbolicLink()).toBe(true);
  });

  it("keeps concurrent replacements complete and removes their temporary files", async () => {
    const path = join(root, "registry.json");
    const values = Array.from({ length: 8 }, (_, index) => `${index}`.repeat(20_000));
    await Promise.all(values.map((value) => atomicWrite(path, value)));
    expect(values).toContain(await fs.readFile(path, "utf8"));
    expect(await fs.readdir(root)).toEqual(["registry.json"]);
    if (process.platform !== "win32") expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  it("cleans up after a failed replacement and preserves the old destination", async () => {
    const path = join(root, "directory");
    await fs.mkdir(path);
    await fs.writeFile(join(path, "keep"), "original");
    await expect(atomicWrite(path, "replacement")).rejects.toThrow();
    expect(await fs.readFile(join(path, "keep"), "utf8")).toBe("original");
    expect(await fs.readdir(root)).toEqual(["directory"]);
  });

  it("sets launcher permissions before exposing the completed file", async () => {
    const path = join(root, "launcher");
    await atomicWrite(path, "#!/bin/sh\n", 0o755);
    expect(await fs.readFile(path, "utf8")).toBe("#!/bin/sh\n");
    if (process.platform !== "win32") expect((await fs.stat(path)).mode & 0o777).toBe(0o755);
  });
});
