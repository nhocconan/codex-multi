import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as registry from "../src/core/registry.ts";

let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-registry-"));
  process.env.CODEX_MULTI_HOME = root;
  delete process.env.CODEX_MULTI_PROFILES_FILE;
});

afterEach(async () => {
  delete process.env.CODEX_MULTI_HOME;
  await fs.rm(root, { recursive: true, force: true });
});

describe("profile registry", () => {
  it("slugifies display names and codex aliases", () => {
    expect(registry.slugify("Personal Account")).toBe("personal-account");
    expect(registry.slugify("codex-Work")).toBe("work");
    expect(registry.slugify("Codex Multi")).toBe("multi-profile");
    expect(registry.slugify("A__B!!")).toBe("a-b");
  });

  it("validates safe slugs", () => {
    expect(registry.validSlug("personal")).toBe(true);
    expect(registry.validSlug("work-2")).toBe(true);
    expect(registry.validSlug("../work")).toBe(false);
    expect(registry.validSlug("Work")).toBe(false);
    expect(registry.validSlug("-work")).toBe(false);
    expect(registry.validSlug("multi")).toBe(false);
    expect(registry.validLabel("Personal")).toBe(true);
    expect(registry.validLabel("Unsafe\u001b[31m")).toBe(false);
  });

  it("round-trips, rewrites, and removes profiles", async () => {
    const profile: registry.Profile = {
      slug: "personal",
      label: "Personal",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await registry.append(profile);
    expect(await registry.find("personal")).toEqual(profile);
    await registry.rewrite("personal", { ...profile, slug: "home", label: "Home" });
    expect(await registry.find("personal")).toBeUndefined();
    expect((await registry.find("home"))?.label).toBe("Home");
    await registry.remove("home");
    expect(await registry.load()).toEqual([]);
  });

  it("ignores malformed and duplicate registry rows", async () => {
    await fs.writeFile(
      join(root, "profiles.json"),
      JSON.stringify([
        { slug: "work", label: "Work", createdAt: "x" },
        { slug: "work", label: "Duplicate", createdAt: "x" },
        { slug: "../escape", label: "Bad", createdAt: "x" },
      ]),
    );
    expect(await registry.load()).toEqual([{ slug: "work", label: "Work", createdAt: "x" }]);
  });

  it("preserves unknown metadata across mutations", async () => {
    await fs.writeFile(
      join(root, "profiles.json"),
      JSON.stringify([
        {
          slug: "work",
          label: "Work",
          createdAt: "x",
          futureMetadata: { color: "blue" },
        },
      ]),
    );
    await registry.append({ slug: "home", label: "Home", createdAt: "y" });
    await registry.rewrite("home", {
      slug: "personal",
      label: "Personal",
      createdAt: "y",
    });
    await registry.remove("personal");
    const raw = JSON.parse(await fs.readFile(join(root, "profiles.json"), "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(raw).toEqual([
      {
        slug: "work",
        label: "Work",
        createdAt: "x",
        futureMetadata: { color: "blue" },
      },
    ]);
  });

  it("serializes concurrent registry updates without losing profiles", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        registry.append({
          slug: `account-${index}`,
          label: `Account ${index}`,
          createdAt: "x",
        }),
      ),
    );
    expect(await registry.load()).toHaveLength(12);
  });

  it("fails closed when the registry root has an unsupported shape", async () => {
    await fs.writeFile(join(root, "profiles.json"), '{"profiles":[]}');
    await expect(registry.load()).rejects.toThrow("must contain a JSON array");
    await expect(
      registry.append({ slug: "work", label: "Work", createdAt: "x" }),
    ).rejects.toThrow("must contain a JSON array");
    expect(await fs.readFile(join(root, "profiles.json"), "utf8")).toBe('{"profiles":[]}');
  });
});
