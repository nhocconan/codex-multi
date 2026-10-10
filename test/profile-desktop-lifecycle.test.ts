import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { edit } from "../src/commands/edit.ts";
import { remove } from "../src/commands/remove.ts";
import { desktop, moveDesktopUserData, setDesktopEnabledLocked } from "../src/commands/desktop.ts";
import * as desktopCore from "../src/core/desktop.ts";
import { desktopAliasPath, desktopUserDataDir, readPlistValues } from "../src/core/desktop.ts";
import { assertDesktopStopped } from "../src/core/desktop-runtime.ts";
import { profileHome, profilesFile } from "../src/core/paths.ts";
import { append, findRegistered, type Profile } from "../src/core/registry.ts";

vi.mock("../src/core/desktop-runtime.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/core/desktop-runtime.ts")>(),
  assertDesktopStopped: vi.fn(),
}));

let root = "";
let app = "";
let profile: Profile;
const environment: Record<string, string | undefined> = {};

async function fakeApp(path: string): Promise<void> {
  await fs.mkdir(join(path, "Contents", "MacOS"), { recursive: true });
  await fs.mkdir(join(path, "Contents", "Resources"), { recursive: true });
  await fs.writeFile(join(path, "Contents", "Resources", "app.icns"), "fake-original-icon");
  await fs.writeFile(join(path, "Contents", "Info.plist"),
    '<plist><dict><key>CFBundleName</key><string>Codex</string>' +
    '<key>CFBundleIconFile</key><string>app.icns</string></dict></plist>');
}

beforeEach(async () => {
  vi.mocked(assertDesktopStopped).mockReset();
  root = await fs.mkdtemp(join(tmpdir(), "cpm-profile-desktop-"));
  app = join(root, "Codex.app");
  await fakeApp(app);
  for (const [key, value] of Object.entries({
    CODEX_MULTI_HOME: join(root, "state"),
    CODEX_MULTI_BASE_HOME: join(root, "base"),
    CODEX_MULTI_BIN_DIR: join(root, "bin"),
    CODEX_MULTI_APPS_DIR: join(root, "Applications"),
    CODEX_MULTI_DESKTOP_APP: app,
    CODEX_MULTI_NO_NATIVE_TOOLS: "1",
  })) {
    environment[key] = process.env[key];
    process.env[key] = value;
  }
  await fs.mkdir(join(root, "base"));
  profile = { slug: "work", label: "Work", createdAt: "2026-01-01T00:00:00.000Z" };
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function seedProfile(desktopEnabled = false): Promise<void> {
  await append({ ...profile, desktop: {
    enabled: desktopEnabled, appPath: app, appName: "Codex", future: { schema: 7 },
  } });
  await fs.mkdir(profileHome("work"), { recursive: true });
  await fs.writeFile(join(profileHome("work"), "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fake-key" }));
}

async function seedDesktop(slug = "work"): Promise<void> {
  await fs.mkdir(desktopUserDataDir(slug), { recursive: true });
  await fs.writeFile(join(desktopUserDataDir(slug), "session.txt"), `${slug} private session`);
}

function failRegistryCommit(): void {
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === profilesFile()) throw new Error("registry write failed");
    return await rename(from, to);
  });
}

describe("desktop registry updates", () => {
  it("reports an alias conflict as an edit failure without claiming success", async () => {
    await seedProfile();
    const foreign = desktopAliasPath("Codex Taken");
    await fs.mkdir(join(foreign, "Contents"), { recursive: true });
    await fs.writeFile(join(foreign, "Contents", "Info.plist"), "foreign app");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(edit("work", { desktop: true, desktopName: "Codex Taken" }))
      .rejects.toThrow("desktop alias could not be refreshed");
    expect(log).not.toHaveBeenCalled();
    expect(await fs.readFile(join(foreign, "Contents", "Info.plist"), "utf8")).toBe("foreign app");
    expect((await findRegistered("work"))?.desktop).toMatchObject({ enabled: false });
  });

  it("preserves evolving desktop fields across enabling, styling, and disabling", async () => {
    await seedProfile();
    await setDesktopEnabledLocked("work", true);
    await setDesktopEnabledLocked("work", true, { color: "purple", aliasName: "Codex Job" });
    await setDesktopEnabledLocked("work", false);
    expect((await findRegistered("work"))?.desktop).toMatchObject({
      enabled: false, aliasName: "Codex Job", color: "purple", future: { schema: 7 },
    });
  });

  it("preserves unknown fields even when enabling an incomplete desktop record", async () => {
    await append({ ...profile, desktop: { enabled: false, future: ["new-field"] } });
    await setDesktopEnabledLocked("work", true);
    expect((await findRegistered("work"))?.desktop).toMatchObject({
      enabled: true, appPath: app, future: ["new-field"],
    });
  });

  it("restores the exact previous enabled alias when a restyle registry commit fails", async () => {
    await seedProfile(true);
    await setDesktopEnabledLocked("work", true, { aliasName: "Original Alias", color: "blue" });
    const original = desktopAliasPath("Original Alias");
    const scriptPath = join(original, "Contents", "MacOS", "codex-multi-desktop");
    const script = await fs.readFile(scriptPath);
    const plist = await fs.readFile(join(original, "Contents", "Info.plist"));
    const icon = await fs.readFile(join(original, "Contents", "Resources", "AppIcon.icns"));
    const otherApp = join(root, "Other.app");
    await fakeApp(otherApp);
    process.env.CODEX_MULTI_DESKTOP_APP = otherApp;
    failRegistryCommit();
    await expect(setDesktopEnabledLocked("work", true, { aliasName: "New Alias", color: "red" }))
      .rejects.toThrow("registry write failed");
    expect(await fs.readFile(scriptPath)).toEqual(script);
    expect(await fs.readFile(join(original, "Contents", "Resources", "AppIcon.icns"))).toEqual(icon);
    expect(await fs.readFile(join(original, "Contents", "Info.plist"))).toEqual(plist);
    await expect(fs.lstat(desktopAliasPath("New Alias"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await findRegistered("work"))?.desktop).toMatchObject({ aliasName: "Original Alias", appPath: app });
  });

  it("restores the alias when disabling cannot be committed", async () => {
    await seedProfile(true);
    await setDesktopEnabledLocked("work", true);
    failRegistryCommit();
    await expect(setDesktopEnabledLocked("work", false)).rejects.toThrow("registry write failed");
    expect(await readPlistValues(join(desktopAliasPath("Codex Work"), "Contents", "Info.plist")))
      .toMatchObject({ CodexMultiSlug: "work" });
    expect((await findRegistered("work"))?.desktop).toMatchObject({ enabled: true });
  });

  it("removes a new alias after a failed initial enable and preserves foreign bundles", async () => {
    await seedProfile();
    const foreign = desktopAliasPath("Foreign");
    await fakeApp(foreign);
    failRegistryCommit();
    await expect(setDesktopEnabledLocked("work", true)).rejects.toThrow("registry write failed");
    await expect(fs.lstat(desktopAliasPath("Codex Work"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(foreign)).isDirectory()).toBe(true);
    expect((await findRegistered("work"))?.desktop).toMatchObject({ enabled: false });
  });

  it("preserves a foreign replacement and the original backup when rollback is blocked", async () => {
    await seedProfile(true);
    await setDesktopEnabledLocked("work", true, { aliasName: "Original Alias" });
    const original = desktopAliasPath("Original Alias");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === profilesFile()) {
        await fakeApp(original);
        await fs.writeFile(join(original, "foreign.txt"), "foreign app");
        throw new Error("registry write failed");
      }
      return await rename(from, to);
    });
    await expect(setDesktopEnabledLocked("work", true, { aliasName: "New Alias" }))
      .rejects.toThrow("preserved original bundles at");
    expect(await fs.readFile(join(original, "foreign.txt"), "utf8")).toBe("foreign app");
    await expect(fs.lstat(join(original, "Contents", "MacOS", "codex-multi-desktop")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const backups = (await fs.readdir(join(root, "Applications")))
      .filter((name) => name.startsWith(".codex-multi-rollback-"));
    expect(backups).toHaveLength(1);
    expect(await readPlistValues(join(root, "Applications", backups[0]!, "0", "Contents", "Info.plist")))
      .toMatchObject({ CodexMultiSlug: "work" });
  });
});

describe("profile desktop data rename", () => {
  it("moves existing desktop data for a disabled profile", async () => {
    await seedProfile();
    await seedDesktop();
    await edit("work", { name: "Job", slug: "job" });
    expect(await fs.readFile(join(desktopUserDataDir("job"), "session.txt"), "utf8"))
      .toBe("work private session");
    await expect(fs.lstat(desktopUserDataDir("work"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await findRegistered("job")).toMatchObject({ label: "Job" });
  });

  it("allows missing desktop data and rejects an orphan destination", async () => {
    expect(await moveDesktopUserData("work", "job")).toBe(false);
    await seedDesktop("job");
    await expect(moveDesktopUserData("work", "job")).rejects.toThrow("already exists");
    expect(await fs.readFile(join(desktopUserDataDir("job"), "session.txt"), "utf8"))
      .toBe("job private session");
  });

  it("rolls the profile home back when a destination desktop directory exists", async () => {
    await seedProfile();
    await seedDesktop();
    await seedDesktop("job");
    await expect(edit("work", { name: "Job", slug: "job" })).rejects.toThrow("already exists");
    expect((await fs.lstat(join(profileHome("work"), "auth.json"))).isFile()).toBe(true);
    await expect(fs.lstat(profileHome("job"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await findRegistered("work")).toBeDefined();
  });

  it("propagates a desktop move error and rolls the profile home back", async () => {
    await seedProfile();
    await seedDesktop();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === desktopUserDataDir("work")) {
        throw Object.assign(new Error("desktop move denied"), { code: "EACCES" });
      }
      return await rename(from, to);
    });
    await expect(edit("work", { name: "Job", slug: "job" })).rejects.toThrow("desktop move denied");
    expect((await fs.lstat(profileHome("work"))).isDirectory()).toBe(true);
    expect((await fs.lstat(desktopUserDataDir("work"))).isDirectory()).toBe(true);
    expect(await findRegistered("work")).toBeDefined();
  });

  it("does not mistake desktop inspection errors for missing data", async () => {
    await seedDesktop();
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (String(args[0]) === desktopUserDataDir("work")) {
        throw Object.assign(new Error("desktop inspection denied"), { code: "EACCES" });
      }
      return await lstat(...args);
    });
    await expect(moveDesktopUserData("work", "job")).rejects.toThrow("desktop inspection denied");
  });

  it("restores both profile and desktop data after registry failure", async () => {
    await seedProfile();
    await seedDesktop();
    failRegistryCommit();
    await expect(edit("work", { name: "Job", slug: "job" })).rejects.toThrow("registry write failed");
    expect((await fs.lstat(profileHome("work"))).isDirectory()).toBe(true);
    expect(await fs.readFile(join(desktopUserDataDir("work"), "session.txt"), "utf8"))
      .toBe("work private session");
    await expect(fs.lstat(profileHome("job"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(desktopUserDataDir("job"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await findRegistered("work")).toBeDefined();
  });

  it("refuses renaming a running desktop but permits a style refresh", async () => {
    await seedProfile(true);
    await setDesktopEnabledLocked("work", true);
    vi.mocked(assertDesktopStopped).mockRejectedValue(new Error("Close desktop work first"));
    await expect(edit("work", { name: "Job", slug: "job" })).rejects.toThrow("Close desktop work first");
    expect((await fs.lstat(profileHome("work"))).isDirectory()).toBe(true);
    vi.mocked(assertDesktopStopped).mockClear();
    await edit("work", { desktopColor: "purple" });
    expect(assertDesktopStopped).not.toHaveBeenCalled();
    expect((await findRegistered("work"))?.desktop).toMatchObject({ color: "purple" });
  });

  it("refuses removing a running desktop before altering its registry, login, or session", async () => {
    await seedProfile(true);
    await seedDesktop();
    await setDesktopEnabledLocked("work", true);
    const auth = await fs.readFile(join(profileHome("work"), "auth.json"));
    vi.mocked(assertDesktopStopped).mockRejectedValue(new Error("Close desktop work first"));
    await expect(remove("work", true)).rejects.toThrow("Close desktop work first");
    expect(await findRegistered("work")).toBeDefined();
    expect(await fs.readFile(join(profileHome("work"), "auth.json"))).toEqual(auth);
    expect(await fs.readFile(join(desktopUserDataDir("work"), "session.txt"), "utf8"))
      .toBe("work private session");
    expect((await fs.lstat(desktopAliasPath("Codex Work"))).isDirectory()).toBe(true);
  });
});

describe("desktop command profile home", () => {
  it("launches a separated profile with private skills, plugins, and sessions", async () => {
    await seedProfile(true);
    const registered = await findRegistered("work");
    await fs.writeFile(profilesFile(), JSON.stringify([{ ...registered, separated: true }]));
    const entries = ["skills", "plugins", "sessions"];
    for (const entry of entries) {
      await fs.mkdir(join(root, "base", entry));
      await fs.writeFile(join(root, "base", entry, "shared.txt"), `base ${entry}`);
    }
    const launch = vi.spyOn(desktopCore, "launchDesktop").mockImplementation(async (launched) => {
      for (const entry of entries) {
        await fs.mkdir(join(profileHome(launched.slug), entry), { recursive: true });
        await fs.writeFile(join(profileHome(launched.slug), entry, "private.txt"), `private ${entry}`);
      }
    });

    await desktop("work");

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ slug: "work", separated: true }));
    for (const entry of entries) {
      expect((await fs.lstat(join(profileHome("work"), entry))).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(join(profileHome("work"), entry, "private.txt"), "utf8"))
        .toBe(`private ${entry}`);
      await expect(fs.lstat(join(profileHome("work"), entry, "shared.txt")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(join(root, "base", entry, "private.txt")))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("launches a shared profile with plugins linked to the base home", async (context) => {
    await seedProfile(true);
    const plugins = join(root, "base", "plugins");
    await fs.mkdir(plugins);
    await fs.writeFile(join(plugins, "shared.txt"), "shared plugin setup");
    if (process.platform === "win32") {
      const probe = join(root, "junction-probe");
      try {
        await fs.symlink(plugins, probe, "junction");
        await fs.unlink(probe);
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          context.skip();
          return;
        }
        throw error;
      }
    }
    const launch = vi.spyOn(desktopCore, "launchDesktop").mockResolvedValue(undefined);

    await desktop("work");

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ slug: "work" }));
    expect((await fs.lstat(join(profileHome("work"), "plugins"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(join(profileHome("work"), "plugins"))).toBe(await fs.realpath(plugins));
    await fs.writeFile(join(plugins, "later.txt"), "updated plugin setup");
    expect(await fs.readFile(join(profileHome("work"), "plugins", "later.txt"), "utf8"))
      .toBe("updated plugin setup");
  });
});
