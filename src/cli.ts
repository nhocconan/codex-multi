import { callbackRouter } from "./core/callback-router.ts";
import { basename } from "node:path";
import { add } from "./commands/add.ts";
import { desktop as desktopCommand, resetPendingDesktop, setDesktopEnabled } from "./commands/desktop.ts";
import { doctor } from "./commands/doctor.ts";
import { edit } from "./commands/edit.ts";
import { launch } from "./commands/launch.ts";
import { list } from "./commands/list.ts";
import { login } from "./commands/login.ts";
import { remove } from "./commands/remove.ts";
import { sync } from "./commands/sync.ts";
import { run as runTui } from "./tui.ts";
import { VERSION } from "./version.ts";

interface Flags {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

export async function main(argv = process.argv): Promise<number> {
  const invoked = basename(argv[1] || "cpm").replace(/\.cmd$/i, "");
  const raw = argv.slice(2);
  if (invoked.startsWith("codex-") && invoked !== "codex-multi") {
    return await launch(invoked.slice("codex-".length), raw);
  }

  const [subcommand, ...rest] = raw;
  if (subcommand === undefined) {
    if (process.stdin.isTTY && process.stdout.isTTY) return await runTui();
    printHelp();
    return 0;
  }
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printHelp();
    return 0;
  }
  if (subcommand === "--version" || subcommand === "-V" || subcommand === "version") {
    if (rest.length) throw new Error("usage: cpm --version");
    console.log(VERSION);
    return 0;
  }
  if (subcommand === "launch" || subcommand === "run" || subcommand === "use") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
      printHelp();
      return 0;
    }
    const slug = rest[0];
    if (!slug) throw new Error(`usage: cpm ${subcommand} <slug> [-- codex args...]`);
    return await launch(slug, rest.slice(1));
  }

  const schema = Object.hasOwn(COMMAND_FLAGS, subcommand) ? COMMAND_FLAGS[subcommand] : undefined;
  if (!schema) throw new Error(`unknown command: ${subcommand}\nRun: cpm --help`);
  const flags = parseFlags(rest);
  if (hasFlag(flags, "help", "h")) {
    printHelp();
    return 0;
  }
  validateCommandFlags(subcommand, flags, schema);
  if (subcommand === "list" || subcommand === "ls") {
    await list();
    return 0;
  }
  if (subcommand === "doctor") return await doctor();
  if (subcommand === "sync") {
    await sync();
    return 0;
  }
  if (subcommand === "callback-router") {
    await callbackRouter(flags.positionals[0] || "status");
    return 0;
  }
  if (subcommand === "desktop") {
    const slug = flags.positionals[0];
    if (!slug) throw new Error(`usage: cpm desktop <slug>`);
    await desktopCommand(slug);
    return 0;
  }
  if (subcommand === "desktop-reset-pending") {
    const slug = flags.positionals[0];
    if (!slug) throw new Error("usage: cpm desktop-reset-pending <slug> --confirm-quit");
    await resetPendingDesktop(slug, hasFlag(flags, "confirm-quit"));
    return 0;
  }
  if (subcommand === "desktop-on" || subcommand === "desktop-off") {
    const slug = flags.positionals[0];
    if (!slug) throw new Error(`usage: cpm ${subcommand} <slug>`);
    await setDesktopEnabled(slug, subcommand === "desktop-on");
    return 0;
  }

  if (subcommand === "add" || subcommand === "import") {
    validateLoginFlags(flags, subcommand === "import" || hasFlag(flags, "import-current"));
    if ((flags.values.has("desktop-name") || flags.values.has("desktop-color")) && !hasFlag(flags, "desktop")) {
      throw new Error("--desktop-name/--desktop-color require --desktop when adding a profile");
    }
    await add({
      ...(flagValue(flags, "name", "n") ? { name: flagValue(flags, "name", "n") } : {}),
      ...(flagValue(flags, "slug", "s") ? { slug: flagValue(flags, "slug", "s") } : {}),
      ...(hasFlag(flags, "device-auth") ? { deviceAuth: true } : {}),
      ...(flagValue(flags, "api-key-env") ? { apiKeyEnv: flagValue(flags, "api-key-env") } : {}),
      ...(flagValue(flags, "access-token-env")
        ? { accessTokenEnv: flagValue(flags, "access-token-env") }
        : {}),
      ...(subcommand === "import" || hasFlag(flags, "import-current")
        ? { importCurrent: true }
        : {}),
      ...(hasFlag(flags, "desktop") ? { desktop: true } : {}),
      ...(flags.values.has("desktop-name")
        ? { desktopName: flagValue(flags, "desktop-name") }
        : {}),
      ...(flags.values.has("desktop-color")
        ? { desktopColor: flagValue(flags, "desktop-color") }
        : {}),
      ...(hasFlag(flags, "separated") ? { separated: true } : {}),
    });
    return 0;
  }
  if (subcommand === "login" || subcommand === "refresh") {
    const slug = flags.positionals[0];
    if (!slug) throw new Error(`usage: cpm ${subcommand} <slug>`);
    validateLoginFlags(flags);
    await login(slug, {
      ...(hasFlag(flags, "device-auth") ? { deviceAuth: true } : {}),
      ...(flagValue(flags, "api-key-env") ? { apiKeyEnv: flagValue(flags, "api-key-env") } : {}),
      ...(flagValue(flags, "access-token-env")
        ? { accessTokenEnv: flagValue(flags, "access-token-env") }
        : {}),
    });
    return 0;
  }
  if (subcommand === "edit" || subcommand === "rename") {
    const slug = flags.positionals[0];
    if (!slug) throw new Error(`usage: cpm ${subcommand} <slug>`);
    await edit(slug, {
      ...(flagValue(flags, "name", "n") ? { name: flagValue(flags, "name", "n") } : {}),
      ...(flagValue(flags, "slug", "s") ? { slug: flagValue(flags, "slug", "s") } : {}),
      ...(hasFlag(flags, "desktop") ? { desktop: true } : {}),
      ...(hasFlag(flags, "no-desktop") ? { noDesktop: true } : {}),
      ...(flags.values.has("desktop-name")
        ? { desktopName: flagValue(flags, "desktop-name") }
        : {}),
      ...(flags.values.has("desktop-color")
        ? { desktopColor: flagValue(flags, "desktop-color") }
        : {}),
    });
    return 0;
  }
  if (subcommand === "remove" || subcommand === "rm") {
    const slug = flags.positionals[0];
    if (!slug) throw new Error(`usage: cpm ${subcommand} <slug> [--yes]`);
    await remove(slug, hasFlag(flags, "yes", "y"));
    return 0;
  }
  throw new Error(`unknown command: ${subcommand}\nRun: cpm --help`);
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "h",
  "device-auth",
  "import-current",
  "yes",
  "y",
  "desktop",
  "no-desktop",
  "separated",
  "confirm-quit",
]);

const VALUE_FLAGS = new Set([
  "name", "n", "slug", "s", "api-key-env", "access-token-env", "desktop-name", "desktop-color",
]);
const FLAG_ALIASES: Record<string, string> = { n: "name", s: "slug", y: "yes", h: "help" };
const LOGIN_FLAGS = ["device-auth", "api-key-env", "access-token-env"];
const DESKTOP_FLAGS = ["desktop", "desktop-name", "desktop-color"];
const ADD_FLAGS = ["name", "n", "slug", "s", ...LOGIN_FLAGS, ...DESKTOP_FLAGS, "import-current", "separated"];
const EDIT_FLAGS = ["name", "n", "slug", "s", ...DESKTOP_FLAGS, "no-desktop"];
const COMMAND_FLAGS: Record<string, { options: string[]; positionals: number }> = {
  add: { options: ADD_FLAGS, positionals: 0 },
  import: { options: ADD_FLAGS, positionals: 0 },
  login: { options: LOGIN_FLAGS, positionals: 1 },
  refresh: { options: LOGIN_FLAGS, positionals: 1 },
  edit: { options: EDIT_FLAGS, positionals: 1 },
  rename: { options: EDIT_FLAGS, positionals: 1 },
  remove: { options: ["yes", "y"], positionals: 1 },
  rm: { options: ["yes", "y"], positionals: 1 },
  "desktop-reset-pending": { options: ["confirm-quit"], positionals: 1 },
  desktop: { options: [], positionals: 1 },
  "desktop-on": { options: [], positionals: 1 },
  "desktop-off": { options: [], positionals: 1 },
  "callback-router": { options: [], positionals: 1 },
  list: { options: [], positionals: 0 },
  ls: { options: [], positionals: 0 },
  doctor: { options: [], positionals: 0 },
  sync: { options: [], positionals: 0 },
};

function validateCommandFlags(command: string, flags: Flags, schema: { options: string[]; positionals: number }): void {
  for (const name of [...flags.values.keys(), ...flags.booleans]) {
    if (!schema.options.includes(name)) throw new Error(`--${name} is not supported by cpm ${command}`);
  }
  if (flags.positionals.length > schema.positionals) {
    throw new Error(`too many arguments for cpm ${command}; run cpm ${command} --help`);
  }
}

function validateLoginFlags(flags: Flags, importing = false): void {
  const modes = LOGIN_FLAGS.filter((name) => flags.values.has(name) || flags.booleans.has(name));
  if (importing && modes.length) throw new Error("login options cannot be combined with importing the current login");
  if (modes.length > 1) throw new Error("choose only one login method: --device-auth, --api-key-env, or --access-token-env");
}

export function parseFlags(args: string[]): Flags {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const normalized = arg.replace(/^-{1,2}/, "");
    const equals = normalized.indexOf("=");
    const name = equals >= 0 ? normalized.slice(0, equals) : normalized;
    if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
      throw new Error(`unknown option: ${arg.split("=", 1)[0]}`);
    }
    const canonical = FLAG_ALIASES[name] ?? name;
    if (seen.has(canonical)) throw new Error(`duplicate option: --${canonical}`);
    seen.add(canonical);
    if (equals >= 0) {
      if (BOOLEAN_FLAGS.has(name)) throw new Error(`--${name} does not take a value`);
      const value = normalized.slice(equals + 1);
      if (!value && name !== "desktop-name") throw new Error(`missing value for --${name}`);
      values.set(name, value);
      continue;
    }
    if (BOOLEAN_FLAGS.has(normalized)) {
      booleans.add(normalized);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`missing value for ${arg}`);
    }
    if (!value && name !== "desktop-name") throw new Error(`missing value for ${arg}`);
    values.set(normalized, value);
    index++;
  }
  return { positionals, values, booleans };
}

function flagValue(flags: Flags, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = flags.values.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function hasFlag(flags: Flags, ...names: string[]): boolean {
  return names.some((name) => flags.booleans.has(name));
}

function printHelp(): void {
  console.log(`codex-multi ${VERSION}

Run multiple Codex CLI accounts side by side.

Usage:
  cpm                              Interactive picker
  cpm add [options]                Create a profile and run codex login
  cpm import [options]             Import the current ~/.codex/auth.json
  cpm list                         List profiles and login status
  cpm launch <slug> [-- args...]   Launch a profile
  cpm use <slug> [-- args...]      Alias for launch
  cpm desktop <slug>               Open a profile in the Codex desktop app (macOS)
  cpm desktop-reset-pending <slug> --confirm-quit  Recover a cancelled desktop launch
  cpm callback-router <enable|disable|status>  Optional browser approval routing (macOS)
  cpm login <slug> [options]       Sign in again (rollback on failure)
  cpm edit <slug> [options]        Rename a profile or launcher
  cpm remove <slug> [--yes]        Delete a profile and its isolated auth
  cpm sync                         Refresh shared config and launchers
  cpm doctor                       Audit isolation, auth, and launchers

Profile options:
  --name, -n <label>               Display name
  --slug, -s <suffix>              Launcher suffix (codex-<suffix>)
  --device-auth                    Use Codex device-code login
  --api-key-env <NAME>             Read API key from an environment variable
  --access-token-env <NAME>        Read access token from an environment variable
  --desktop                        Also add a desktop app alias (macOS)
  --desktop-name <name>            Custom desktop alias name
  --desktop-color <color>          Alias icon badge color (auto|none|red|orange|yellow|
                                   green|teal|blue|purple|pink|cyan|lime)
  --separated                      Keep this profile's Codex state fully private

Edit options:
  --desktop / --no-desktop         Enable or remove the desktop app alias
  --desktop-name <name>            Rename the desktop app alias ("" resets to default)
  --desktop-color <color>          Change the alias icon badge color

Examples:
  npx codex-multi add --name Personal --slug personal
  npx codex-multi add --name Work --slug work --device-auth
  npx codex-multi add --name Work --slug work --desktop
  codex-personal
  codex-work exec "review this repository"
`);
}

if (process.env.CODEX_MULTI_NO_AUTO_RUN !== "1") {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
