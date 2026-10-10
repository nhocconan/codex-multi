import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  desktopAliasName,
  desktopAliasPath,
  desktopAppsDir,
  desktopConfigOf,
  desktopInfoPlist,
  desktopScript,
  desktopUserDataDir,
  detectDesktopApp,
  installDesktopAlias,
  isOwnedAliasBundle,
  ownedAliasBundles,
  readPlistValues,
  removeDesktopAliases,
  syncDesktopAliases,
  validAliasName,
} from "../src/core/desktop.ts";
import { setDesktopEnabledLocked } from "../src/commands/desktop.ts";
import { buildProfileHome, isPrivateName } from "../src/core/profile-home.ts";
import { append } from "../src/core/registry.ts";
import type { Profile } from "../src/core/registry.ts";

process.env.CODEX_MULTI_NO_AUTO_RUN = "1";
const { parseFlags } = await import("../src/cli.ts");

let root = "";
let appsDir = "";
let fakeAppPath = "";
const savedEnv: Record<string, string | undefined> = {};

const work: Profile = {
  slug: "work",
  label: "Work",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function envProfile(profile: Profile, desktop: Record<string, unknown>): Profile {
  return { ...profile, desktop };
}

async function createFakeApp(path: string, name = "ChatGPT"): Promise<void> {
  await fs.mkdir(join(path, "Contents", "MacOS"), { recursive: true });
  await fs.writeFile(join(path, "Contents", "MacOS", "ChatGPT"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  await fs.writeFile(
    join(path, "Contents", "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<plist version=\"1.0\"><dict>",
      "<key>CFBundleIdentifier</key><string>com.openai.codex</string>",
      `<key>CFBundleName</key><string>${name}</string>`,
      "<key>CFBundleIconFile</key><string>app.icns</string>",
      "</dict></plist>",
    ].join("\n"),
  );
  await fs.mkdir(join(path, "Contents", "Resources"), { recursive: true });
  await fs.writeFile(join(path, "Contents", "Resources", "app.icns"), "fake-icon");
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpm-desktop-"));
  appsDir = join(root, "Applications");
  fakeAppPath = join(root, "ChatGPT.app");
  await createFakeApp(fakeAppPath);
  for (const [key, value] of Object.entries({
    CODEX_MULTI_HOME: join(root, "state"),
    CODEX_MULTI_BASE_HOME: join(root, "base-codex"),
    CODEX_MULTI_PROFILES_FILE: join(root, "state", "profiles.json"),
    CODEX_MULTI_PROFILES_DIR: join(root, "state", "profiles"),
    CODEX_MULTI_APPS_DIR: appsDir,
    CODEX_MULTI_DESKTOP_APP: fakeAppPath,
    CODEX_MULTI_NO_NATIVE_TOOLS: "1",
  })) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  await fs.mkdir(join(root, "base-codex", "skills"), { recursive: true });
  await fs.writeFile(join(root, "base-codex", "config.toml"), 'model = "gpt-5"\n');
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("desktop detection", () => {
  it("detects the configured desktop app with name and icon", async () => {
    const app = await detectDesktopApp();
    expect(app.path).toBe(fakeAppPath);
    expect(app.name).toBe("ChatGPT");
    expect(app.iconPath).toBe(join(fakeAppPath, "Contents", "Resources", "app.icns"));
  });

  it("reads plist values without native tools", async () => {
    const values = await readPlistValues(join(fakeAppPath, "Contents", "Info.plist"));
    expect(values["CFBundleIdentifier"]).toBe("com.openai.codex");
    expect(values["CFBundleName"]).toBe("ChatGPT");
  });
});

describe("alias naming and validation", () => {
  it("derives the alias name from the app name and profile label", () => {
    const profile = envProfile(work, {
      enabled: true,
      appPath: fakeAppPath,
      appName: "ChatGPT",
    });
    expect(desktopAliasName(profile, { name: "ChatGPT" })).toBe("ChatGPT Work");
  });

  it("prefers an explicit alias name", () => {
    const profile = envProfile(work, {
      enabled: true,
      appPath: fakeAppPath,
      appName: "ChatGPT",
      aliasName: "Codex Job",
    });
    expect(desktopAliasName(profile, { name: "ChatGPT" })).toBe("Codex Job");
  });

  it("rejects alias names that cannot be bundle names", () => {
    expect(validAliasName("ChatGPT Work")).toBe(true);
    expect(validAliasName("a".repeat(81))).toBe(false);
    expect(validAliasName("bad/name")).toBe(false);
    expect(validAliasName("trailing.")).toBe(false);
    expect(validAliasName(" padded ")).toBe(false);
    expect(validAliasName("")).toBe(false);
  });
});

describe("bundle content generation", () => {
  it("treats leading XML markup as literal alias text", async () => {
    const name = '<Work & "Research">';
    const plist = desktopInfoPlist(name, "work", "blue");
    expect(plist).toContain("<string>&lt;Work &amp; &quot;Research&quot;&gt;</string>");
    expect(plist).toContain("<key>LSUIElement</key>\n  <true/>");
    const path = join(root, "escaped.plist");
    await fs.writeFile(path, plist);
    expect((await readPlistValues(path)).CFBundleName).toBe(name);
  });

  it.skipIf(process.platform === "win32")("executes with scrubbed auth and baked manager scope, including quoted paths", async () => {
    const manager = join(root, "state", "runtime", "desktop-cli.mjs");
    await fs.mkdir(join(root, "state", "runtime"), { recursive: true });
    await fs.writeFile(manager, `console.log(JSON.stringify({
      args: process.argv.slice(2),
      authPresent: ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"].some(k => !!process.env[k]),
      ambientDesktopPresent: !!process.env.CODEX_ELECTRON_USER_DATA_PATH,
      home: process.env.CODEX_MULTI_HOME,
      app: process.env.CODEX_MULTI_DESKTOP_APP,
    }));`);
    const executable = join(root, "alias-script");
    await fs.writeFile(executable, desktopScript("work", { path: "/Applications/Codex 'Work'.app" }, "/homes/work", "/data/work"));
    const { stdout } = await promisify(execFile)("/bin/sh", [executable], { env: {
      ...process.env, OPENAI_API_KEY: "fake", CODEX_ACCESS_TOKEN: "fake", OPENAI_ORG_ID: "fake", OPENAI_PROJECT_ID: "fake",
      CODEX_HOME: "/wrong/home", CODEX_ELECTRON_USER_DATA_PATH: "/wrong/data", CODEX_MULTI_HOME: "/wrong/registry",
    } });
    expect(JSON.parse(stdout)).toEqual({ args: ["desktop", "work"], authPresent: false, ambientDesktopPresent: false,
      home: join(root, "state"), app: "/Applications/Codex 'Work'.app" });
  });
  it("escapes XML specials in the plist", () => {
    const plist = desktopInfoPlist('Bad <"&\'> Name', "work", "blue");
    expect(plist).toContain("<string>Bad &lt;&quot;&amp;&apos;&gt; Name</string>");
    expect(plist).toContain("<key>CodexMultiSlug</key>");
    expect(plist).toContain("<string>badge2:blue</string>");
    expect(plist).toContain("<string>io.github.nhocconan.codex-multi.profile.work</string>");
  });

  it("bakes isolated paths into the launcher script", () => {
    const script = desktopScript(
      "work",
      { path: "/Applications/Chat GPT.app" },
      "/homes/work codex",
      "/data/work 'quotes'",
    );
    expect(script).toContain("unset CODEX_HOME CODEX_ELECTRON_USER_DATA_PATH");
    expect(script).toContain("CODEX_HOME='/homes/work codex'");
    expect(script).toContain("desktop-cli.mjs' desktop 'work'");
    expect(script).not.toContain("/data/work 'quotes'"); // single quotes are escaped
  });

  it("parses desktop config tolerantly", () => {
    expect(desktopConfigOf(work)).toBeUndefined();
    expect(
      desktopConfigOf(envProfile(work, { enabled: "yes", appPath: "/x" })),
    ).toBeUndefined();
    const config = desktopConfigOf(
      envProfile(work, { enabled: true, appPath: "/x", appName: "ChatGPT", extra: 1 }),
    );
    expect(config).toMatchObject({ enabled: true, appPath: "/x", appName: "ChatGPT" });
  });
});

describe("alias installation", () => {
  it("rejects an alias owned by another profile without changing it", async () => {
    const app = await detectDesktopApp();
    await installDesktopAlias(work, app);
    const path = desktopAliasPath("ChatGPT Work");
    const before = await fs.readFile(join(path, "Contents", "Info.plist"));
    await expect(installDesktopAlias({ ...work, slug: "other" }, app)).rejects.toThrow(/belongs to another app/);
    expect(await fs.readFile(join(path, "Contents", "Info.plist"))).toEqual(before);
  });

  it("serializes two profiles requesting the same alias", async () => {
    const app = await detectDesktopApp();
    const results = await Promise.allSettled([installDesktopAlias(work, app), installDesktopAlias({ ...work, slug: "other" }, app)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });

  it("keeps an old alias when staging a rename fails", async () => {
    const app = await detectDesktopApp();
    await installDesktopAlias(work, app);
    const path = desktopAliasPath("ChatGPT Work");
    const before = await fs.readFile(join(path, "Contents", "Info.plist"));
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (String(args[0]).includes(".codex-multi-stage-")) throw new Error("staging denied");
      return await writeFile(...args);
    });
    await expect(installDesktopAlias({ ...work, label: "Job" }, app)).rejects.toThrow("staging denied");
    expect(await fs.readFile(join(path, "Contents", "Info.plist"))).toEqual(before);
    expect(existsSync(desktopAliasPath("ChatGPT Job"))).toBe(false);
  });

  it("restores a replaced alias if committing the staged bundle fails", async () => {
    const app = await detectDesktopApp();
    await installDesktopAlias(work, app);
    const path = desktopAliasPath("ChatGPT Work");
    const before = await fs.readFile(join(path, "Contents", "Info.plist"));
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).endsWith("alias.app") && String(to) === path) throw new Error("commit denied");
      return await rename(from, to);
    });
    await expect(installDesktopAlias(work, app)).rejects.toThrow("commit denied");
    expect(await fs.readFile(join(path, "Contents", "Info.plist"))).toEqual(before);
    expect((await fs.readdir(appsDir)).some(name => name.startsWith(".codex-multi-stage-"))).toBe(false);
  });

  it("preserves the old bundle backup if a foreign app blocks rollback", async () => {
    const app = await detectDesktopApp();
    await installDesktopAlias(work, app);
    const path = desktopAliasPath("ChatGPT Work");
    const before = await fs.readFile(join(path, "Contents", "Info.plist"));
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).endsWith("alias.app") && String(to) === path) {
        await fs.mkdir(join(path, "Contents"), { recursive: true });
        await fs.writeFile(join(path, "Contents", "Info.plist"), "foreign replacement");
        throw new Error("commit denied");
      }
      return await rename(from, to);
    });
    await expect(installDesktopAlias(work, app)).rejects.toThrow("original bundle preserved");
    expect(await fs.readFile(join(path, "Contents", "Info.plist"), "utf8")).toBe("foreign replacement");
    const backup = (await fs.readdir(appsDir)).find(name => name.startsWith(".codex-multi-stage-"));
    expect(backup).toBeDefined();
    expect(await fs.readFile(join(appsDir, backup!, "previous.app", "Contents", "Info.plist"))).toEqual(before);
  });

  it("does not adopt another manager root's marked alias", async () => {
    const app = await detectDesktopApp();
    await installDesktopAlias(work, app);
    const path = desktopAliasPath("ChatGPT Work");
    const plistPath = join(path, "Contents", "Info.plist");
    const plist = await fs.readFile(plistPath, "utf8");
    await fs.writeFile(plistPath, plist.replace(join(root, "state"), join(root, "foreign-state")));
    await expect(installDesktopAlias(work, app)).rejects.toThrow(/belongs to another app/);
    expect(await removeDesktopAliases(work.slug)).toBe(0);
    expect(existsSync(path)).toBe(true);
  });
  it("creates a marker-owned bundle with launcher script and icon", async () => {
    const app = await detectDesktopApp();
    const installed = await installDesktopAlias(work, app);
    expect(installed).toEqual({ path: desktopAliasPath("ChatGPT Work"), created: true });

    const bundle = desktopAliasPath("ChatGPT Work");
    const plist = await readPlistValues(join(bundle, "Contents", "Info.plist"));
    expect(plist["CodexMultiSlug"]).toBe("work");
    expect(plist["CFBundleIdentifier"]).toBe("io.github.nhocconan.codex-multi.profile.work");
    expect(plist["CFBundleExecutable"]).toBe("codex-multi-desktop");
    expect(plist["CodexMultiIcon"]).toContain("badge2:");
    expect(await isOwnedAliasBundle(bundle)).toBe(true);

    const script = await fs.readFile(
      join(bundle, "Contents", "MacOS", "codex-multi-desktop"),
      "utf8",
    );
    expect(script).toContain("desktop-cli.mjs' desktop 'work'");
    expect(script).toContain(`CODEX_HOME='${join(root, "state", "profiles", "work")}'`);
    expect(script).toContain(`DATA_DIR='${desktopUserDataDir("work")}'`);
    expect(script).toContain(`APP_PATH='${fakeAppPath}'`);

    const icon = await fs.readFile(join(bundle, "Contents", "Resources", "AppIcon.icns"), "utf8");
    expect(icon).toBe("fake-icon");
  });

  it("refuses to replace a foreign bundle", async () => {
    const app = await detectDesktopApp();
    const foreign = desktopAliasPath("ChatGPT Work");
    await createFakeApp(foreign, "Something Else");
    await expect(installDesktopAlias(work, app)).rejects.toThrow(/belongs to another app/);
    expect(await isOwnedAliasBundle(foreign)).toBe(false);
  });

  it("moves the alias when the profile label changes", async () => {
    const app = await detectDesktopApp();
    await installDesktopAlias(work, app);
    const renamed: Profile = { ...work, label: "Job" };
    await installDesktopAlias(renamed, app);
    expect(await isOwnedAliasBundle(desktopAliasPath("ChatGPT Work"))).toBe(false);
    expect(await isOwnedAliasBundle(desktopAliasPath("ChatGPT Job"))).toBe(true);
  });

  it("removes only owned bundles for the profile", async () => {
    const app = await detectDesktopApp();
    await installDesktopAlias(work, app);
    const foreign = desktopAliasPath("Foreign App");
    await createFakeApp(foreign, "Foreign");

    expect(await removeDesktopAliases("work")).toBe(1);
    expect(await fs.stat(desktopAliasPath("ChatGPT Work")).catch(() => null)).toBeNull();
    expect(await fs.stat(foreign)).toBeTruthy();
  });
});

describe("alias synchronization", () => {
  it("is a no-op when bundles are current", async () => {
    const profile = envProfile(work, {
      enabled: true,
      appPath: fakeAppPath,
      appName: "ChatGPT",
    });
    await syncDesktopAliases([profile]);
    const again = await syncDesktopAliases([profile]);
    expect(again).toMatchObject({ created: 0, updated: 0, removed: 0, conflicts: [] });
  });

  it("reports created and removed counts", async () => {
    const profile = envProfile(work, {
      enabled: true,
      appPath: fakeAppPath,
      appName: "ChatGPT",
    });
    const result = await syncDesktopAliases([profile]);
    expect(result.created).toBe(1);

    const disabled = envProfile(work, {
      enabled: false,
      appPath: fakeAppPath,
      appName: "ChatGPT",
    });
    const afterDisable = await syncDesktopAliases([disabled]);
    expect(afterDisable.removed).toBe(1);
    expect(await ownedAliasBundles()).toEqual([]);
  });

  it("rebuilds a bundle whose baked content went stale", async () => {
    const profile = envProfile(work, {
      enabled: true,
      appPath: fakeAppPath,
      appName: "ChatGPT",
    });
    await syncDesktopAliases([profile]);
    const bundle = desktopAliasPath("ChatGPT Work");
    await fs.writeFile(
      join(bundle, "Contents", "MacOS", "codex-multi-desktop"),
      "#!/bin/sh\n# stale\n",
    );
    const result = await syncDesktopAliases([profile]);
    expect(result.updated).toBe(1);
    const script = await fs.readFile(
      join(bundle, "Contents", "MacOS", "codex-multi-desktop"),
      "utf8",
    );
    expect(script).toContain("codex-multi desktop launcher");
  });

  it("surfaces conflicts for foreign bundles and missing apps", async () => {
    const profile = envProfile(work, {
      enabled: true,
      appPath: fakeAppPath,
      appName: "ChatGPT",
    });
    const foreign = desktopAliasPath("ChatGPT Work");
    await createFakeApp(foreign, "Other");
    const result = await syncDesktopAliases([profile]);
    expect(result.created).toBe(0);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]).toContain("belongs to another app");
  });
});

describe("enable/disable through the registry", () => {
  it("installs the bundle on enable and keeps a disabled record on disable", async () => {
    await append(work);
    await setDesktopEnabledLocked("work", true, {});
    const bundle = desktopAliasPath("ChatGPT Work");
    expect(await isOwnedAliasBundle(bundle)).toBe(true);

    await setDesktopEnabledLocked("work", false);
    expect(existsSync(bundle)).toBe(false);
    const registry = JSON.parse(
      await fs.readFile(process.env.CODEX_MULTI_PROFILES_FILE!, "utf8"),
    );
    expect(registry[0].desktop).toMatchObject({ enabled: false, appName: "ChatGPT" });
  });

  it("records an explicit badge color and rejects unknown colors", async () => {
    await append(work);
    await setDesktopEnabledLocked("work", true, { color: "purple" });
    const registry = JSON.parse(
      await fs.readFile(process.env.CODEX_MULTI_PROFILES_FILE!, "utf8"),
    );
    expect(registry[0].desktop).toMatchObject({ color: "purple" });

    await expect(setDesktopEnabledLocked("work", true, { color: "mauve" })).rejects.toThrow(
      /unknown desktop color/,
    );
  });

  it("copies the original icon when badge rendering is unavailable", async () => {
    const app = await detectDesktopApp();
    await installDesktopAlias(work, app);
    const icon = await fs.readFile(
      join(desktopAliasPath("ChatGPT Work"), "Contents", "Resources", "AppIcon.icns"),
    );
    expect(icon.equals(await fs.readFile(app.iconPath!))).toBe(true);
  });

  it.skipIf(process.platform === "darwin")(
    "rejects enabling outside macOS",
    async () => {
      delete process.env.CODEX_MULTI_NO_NATIVE_TOOLS;
      await append(work);
      await expect(setDesktopEnabledLocked("work", true, {})).rejects.toThrow(/macOS/);
    },
  );
});

describe("separated profiles", () => {
  it("keeps desktop UI state private while sharing the rest", async () => {
    await fs.writeFile(join(root, "base-codex", ".codex-global-state.json"), "{}");
    expect(isPrivateName(".codex-global-state.json")).toBe(true);
    expect(isPrivateName(".codex-global-state.json.bak")).toBe(true);

    const home = await buildProfileHome("work");
    expect(await fs.lstat(join(home, "skills"))).toBeTruthy(); // symlinked share
    expect(
      await fs.lstat(join(home, ".codex-global-state.json")).catch(() => null),
    ).toBeNull(); // stays private
  });

  it("separated homes link nothing but still mirror config", async () => {
    const home = await buildProfileHome("work", true);
    expect(await fs.lstat(join(home, "skills")).catch(() => null)).toBeNull();
    const config = await fs.readFile(join(home, "config.toml"), "utf8");
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).toContain('model = "gpt-5"');
  });
});

describe("cli flags", () => {
  it("parses desktop and separated as booleans", () => {
    const flags = parseFlags([
      "--name",
      "Work",
      "--slug",
      "work",
      "--desktop",
      "--separated",
      "--desktop-name",
      "Codex Job",
    ]);
    expect(flags.booleans.has("desktop")).toBe(true);
    expect(flags.booleans.has("separated")).toBe(true);
    expect(flags.values.get("desktop-name")).toBe("Codex Job");
    expect(flags.positionals).toEqual([]);
  });

  it("keeps desktop-name as a value flag", () => {
    const flags = parseFlags(["--no-desktop", "--desktop-name", "X"]);
    expect(flags.booleans.has("no-desktop")).toBe(true);
    expect(flags.values.get("desktop-name")).toBe("X");
  });

  it("accepts an explicit empty desktop-name to reset the alias name", () => {
    const flags = parseFlags(["--desktop-name", ""]);
    expect(flags.values.has("desktop-name")).toBe(true);
    expect(flags.values.get("desktop-name")).toBe("");
  });

  it("parses desktop-color as a value flag", () => {
    const flags = parseFlags(["--desktop", "--desktop-color", "teal"]);
    expect(flags.booleans.has("desktop")).toBe(true);
    expect(flags.values.get("desktop-color")).toBe("teal");
  });
});
