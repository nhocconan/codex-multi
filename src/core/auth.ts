import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { baseCodexHome, profileHome } from "./paths.ts";

export interface AuthSummary {
  ok: boolean;
  mode: string;
  identity?: string;
  plan?: string;
  problem?: string;
}

export function authPath(slug: string): string {
  return join(profileHome(slug), "auth.json");
}

export function baseAuthPath(): string {
  return join(baseCodexHome(), "auth.json");
}

export function authBackupPath(slug: string): string {
  return `${authPath(slug)}.cpm-backup`;
}

export async function recoverAuthBackup(slug: string): Promise<void> {
  const auth = authPath(slug);
  const backup = authBackupPath(slug);
  try {
    await fs.lstat(backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    await fs.lstat(auth);
    const current = await inspectAuth(slug);
    if (current.ok) {
      await fs.unlink(backup);
    } else {
      await fs.unlink(auth);
      await fs.rename(backup, auth);
      if (process.platform !== "win32") await fs.chmod(auth, 0o600);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.rename(backup, auth);
    if (process.platform !== "win32") await fs.chmod(auth, 0o600);
  }
}

export async function copyCurrentAuth(slug: string): Promise<void> {
  const source = baseAuthPath();
  const bytes = await fs.readFile(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(
        `no file-based Codex login found at ${source}; run codex login with cli_auth_credentials_store="file" first`,
      );
    }
    throw error;
  });
  JSON.parse(bytes.toString("utf8"));
  await atomicWrite(authPath(slug), bytes);
}

export async function inspectAuth(slug: string): Promise<AuthSummary> {
  let parsed: Record<string, unknown>;
  try {
    const raw = await fs.readFile(authPath(slug), "utf8");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, mode: "unknown", problem: "auth.json is not an object" };
    }
    parsed = value as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      mode: "unknown",
      problem: code === "ENOENT" ? "auth.json is missing" : "auth.json is unreadable",
    };
  }

  const mode = typeof parsed.auth_mode === "string" ? parsed.auth_mode : "unknown";
  const hasApiKey = typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0;
  const tokens =
    parsed.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)
      ? (parsed.tokens as Record<string, unknown>)
      : undefined;
  const hasTokens =
    !!tokens &&
    ["access_token", "refresh_token", "id_token"].some(
      (key) => typeof tokens[key] === "string" && (tokens[key] as string).length > 0,
    );
  if (!hasApiKey && !hasTokens) {
    return { ok: false, mode, problem: "auth.json contains no usable credential" };
  }

  const claims =
    tokens && typeof tokens.id_token === "string" ? decodeJwtClaims(tokens.id_token) : undefined;
  const identity = firstString(claims, [
    "email",
    "https://api.openai.com/profile",
    "preferred_username",
  ], ["email", "preferred_username"]);
  const plan = firstString(
    claims,
    ["chatgpt_plan_type", "https://api.openai.com/auth"],
    ["chatgpt_plan_type", "plan_type"],
  );
  return {
    ok: true,
    mode: mode === "unknown" ? (hasApiKey ? "api" : "chatgpt") : mode,
    ...(identity ? { identity } : {}),
    ...(plan ? { plan } : {}),
  };
}

export async function authFingerprint(slug: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(authPath(slug));
    let stableCredential: string | undefined;
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      const tokens =
        parsed.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)
          ? (parsed.tokens as Record<string, unknown>)
          : {};
      stableCredential = [
        tokens.account_id,
        tokens.refresh_token,
        parsed.OPENAI_API_KEY,
        tokens.access_token,
      ].find((value): value is string => typeof value === "string" && value.length > 0);
    } catch {
      // Hash malformed files by content so doctor can still compare them safely.
    }
    return createHash("sha256").update(stableCredential ?? bytes).digest("hex");
  } catch {
    return undefined;
  }
}

export async function atomicWrite(path: string, content: Uint8Array | string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, path);
  if (process.platform !== "win32") await fs.chmod(path, 0o600);
}

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function firstString(
  source: Record<string, unknown> | undefined,
  keys: string[],
  nestedKeys: string[] = [],
): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      for (const nestedKey of nestedKeys) {
        if (typeof nested[nestedKey] === "string") return nested[nestedKey] as string;
      }
    }
  }
  return undefined;
}
