import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataRoot, validProfileSlug } from "./paths.ts";

const execFileAsync = promisify(execFile);
const PENDING_OWNER = "codex-multi desktop pending launch";

export function desktopPendingLaunchPath(slug: string): string {
  if (!validProfileSlug(slug)) throw new Error("invalid profile slug");
  return join(dataRoot(), "desktop-pending", `${slug}.json`);
}

async function hasPendingDesktopLaunch(slug: string): Promise<boolean> {
  const path = desktopPendingLaunchPath(slug);
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("not a private regular file");
    const state = JSON.parse(await fs.readFile(path, "utf8"));
    if (state?.owner !== PENDING_OWNER || state?.slug !== slug || state?.root !== resolve(dataRoot())) {
      throw new Error("ownership mismatch");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`cannot validate pending desktop launch for ${slug}; keep the profile unchanged and repair its pending marker`, { cause: error });
  }
}

async function resolvePendingDesktopLaunch(slug: string): Promise<void> {
  if (await hasPendingDesktopLaunch(slug)) await fs.unlink(desktopPendingLaunchPath(slug));
}

function unresolvedLaunch(slug: string): Error {
  return new Error(`desktop profile ${slug} has an unresolved launch; quit the app and cancel queued launches, then run "cpm desktop-reset-pending ${slug} --confirm-quit"`);
}

/** Caller holds the profile lifecycle lock until startup has been observed. */
export async function prepareDesktopLaunch(slug: string): Promise<boolean> {
  const pending = await hasPendingDesktopLaunch(slug);
  if ((await runningDesktopPids(slug)).length > 0) {
    if (pending) await resolvePendingDesktopLaunch(slug);
    return false;
  }
  if (pending) throw unresolvedLaunch(slug);
  const path = desktopPendingLaunchPath(slug);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, JSON.stringify({ owner: PENDING_OWNER, slug, root: resolve(dataRoot()) }) + "\n", {
    flag: "wx", mode: 0o600,
  });
  return true;
}

/** Caller holds mutation/lifecycle locks; acknowledgement is an explicit user choice. */
export async function clearPendingDesktopLaunch(slug: string, acknowledgedQuit: boolean): Promise<void> {
  if (!acknowledgedQuit) throw new Error("confirm the desktop app is quit and queued launches are cancelled with --confirm-quit");
  if ((await runningDesktopPids(slug)).length > 0) {
    throw new Error(`desktop profile ${slug} is running; quit its desktop app before clearing the pending launch`);
  }
  await resolvePendingDesktopLaunch(slug);
}

/** Match the actual app process, rather than its renderer/helper children. */
export function desktopPidsFromPs(output: string, dataDir: string): number[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const args = match[2]!;
    if (!args.includes(".app/Contents/MacOS/") || /\s--type=/.test(args)) return [];
    const flag = ` --user-data-dir=${dataDir}`;
    const offset = args.indexOf(flag);
    if (offset < 0) return [];
    const tail = args.slice(offset + flag.length);
    if (tail !== "" && !tail.startsWith(" --")) return [];
    return [Number(match[1])];
  });
}

export async function runningDesktopPids(slug: string): Promise<number[]> {
  if (process.platform !== "darwin" || process.env.CODEX_MULTI_NO_NATIVE_TOOLS === "1") return [];
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,args="], { maxBuffer: 8 * 1024 * 1024 });
    return desktopPidsFromPs(stdout, join(dataRoot(), "desktop", slug));
  } catch (error) {
    throw new Error(`could not check running desktop profiles: ${(error as Error).message}`, { cause: error });
  }
}

/** Called under mutation/lifecycle locks before replacing a home or credentials. */
export async function assertDesktopStopped(slug: string): Promise<void> {
  const pending = await hasPendingDesktopLaunch(slug);
  if ((await runningDesktopPids(slug)).length > 0) {
    if (pending) await resolvePendingDesktopLaunch(slug);
    throw new Error(`desktop profile ${slug} is running; quit its desktop app before signing in again, renaming, or removing it`);
  }
  if (pending) throw unresolvedLaunch(slug);
}

export async function waitForDesktopStartup(slug: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await runningDesktopPids(slug)).length > 0) {
      await resolvePendingDesktopLaunch(slug);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`desktop profile ${slug} did not start; check the desktop app and try again`);
}
