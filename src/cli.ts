import { basename } from "node:path";
import { add } from "./commands/add.ts";
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
  if (invoked.startsWith("codex-") && invoked !== "codex-profile-manager") {
    return await launch(invoked.slice("codex-".length), raw);
  }

  const [subcommand, ...rest] = raw;
  if (subcommand === undefined) return await runTui();
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printHelp();
    return 0;
  }
  if (subcommand === "--version" || subcommand === "-V" || subcommand === "version") {
    console.log(VERSION);
    return 0;
  }
  if (subcommand === "list" || subcommand === "ls") {
    await list();
    return 0;
  }
  if (subcommand === "doctor") return await doctor();
  if (subcommand === "sync") {
    await sync();
    return 0;
  }
  if (subcommand === "launch" || subcommand === "run" || subcommand === "use") {
    const slug = rest[0];
    if (!slug) throw new Error(`usage: cpm ${subcommand} <slug> [-- codex args...]`);
    return await launch(slug, rest.slice(1));
  }

  const flags = parseFlags(rest);
  if (subcommand === "add" || subcommand === "import") {
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
    });
    return 0;
  }
  if (subcommand === "login" || subcommand === "refresh") {
    const slug = flags.positionals[0];
    if (!slug) throw new Error(`usage: cpm ${subcommand} <slug>`);
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

const BOOLEAN_FLAGS = new Set(["device-auth", "import-current", "yes", "y"]);

export function parseFlags(args: string[]): Flags {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
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
    if (equals >= 0) {
      values.set(normalized.slice(0, equals), normalized.slice(equals + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(normalized)) {
      booleans.add(normalized);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`missing value for ${arg}`);
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
  console.log(`codex-profile-manager ${VERSION}

Run multiple Codex CLI accounts side by side.

Usage:
  cpm                              Interactive picker
  cpm add [options]                Create a profile and run codex login
  cpm import [options]             Import the current ~/.codex/auth.json
  cpm list                         List profiles and login status
  cpm launch <slug> [-- args...]   Launch a profile
  cpm use <slug> [-- args...]      Alias for launch
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

Examples:
  npx codex-profile-manager add --name Personal --slug personal
  npx codex-profile-manager add --name Work --slug work --device-auth
  codex-personal
  codex-work exec "review this repository"
`);
}

if (process.env.CODEX_PROFILE_MANAGER_NO_AUTO_RUN !== "1") {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
