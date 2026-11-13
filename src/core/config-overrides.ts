import { parse } from "smol-toml";

const FILE_STORE = ['-c', 'cli_auth_credentials_store="file"'];

export function withFileCredentialStore(args: string[]): string[] {
  assertFileCredentialStore(args);
  return [...FILE_STORE, ...args];
}

function credentialStores(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "cli_auth_credentials_store" ? [child] : credentialStores(child),
  );
}

export function assertFileCredentialStore(args: string[]): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    let override: string | undefined;
    if (arg === "-c" || arg === "--config") override = args[++index];
    else if (arg.startsWith("--config=")) override = arg.slice("--config=".length);
    else if (arg.startsWith("-c") && arg.length > 2) override = arg.slice(2).replace(/^=/, "");
    if (!override) continue;

    let stores: unknown[];
    try {
      stores = credentialStores(parse(override));
    } catch {
      const equals = override.indexOf("=");
      if (equals < 0) continue;
      try {
        stores = credentialStores(parse(`${override.slice(0, equals)} = "placeholder"`));
      } catch {
        continue;
      }
      // Codex accepts bare string override values as well as TOML strings.
      if (stores.length && override.slice(equals + 1).trim() === "file") continue;
    }
    if (stores.some((store) => store !== "file")) {
      throw new Error(
        'Managed profiles require cli_auth_credentials_store="file". Remove the credential-store override to keep this account isolated.',
      );
    }
  }
}
