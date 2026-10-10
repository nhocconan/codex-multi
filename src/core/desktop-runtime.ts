import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { dataRoot } from "./paths.ts";

const execFileAsync = promisify(execFile);

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
  if ((await runningDesktopPids(slug)).length > 0) {
    throw new Error(`desktop profile ${slug} is running; quit its desktop app before signing in again, renaming, or removing it`);
  }
}

export async function waitForDesktopStartup(slug: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await runningDesktopPids(slug)).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`desktop profile ${slug} did not start; check the desktop app and try again`);
}
