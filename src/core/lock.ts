import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";

const inProcessLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  path: string,
  action: () => Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  const previous = inProcessLocks.get(path) ?? Promise.resolve();
  let releaseInProcess: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    releaseInProcess = resolve;
  });
  inProcessLocks.set(path, current);

  await previous;

  try {
    return await withCrossProcessLock(path, action, timeoutMs);
  } finally {
    if (inProcessLocks.get(path) === current) {
      inProcessLocks.delete(path);
    }
    releaseInProcess();
  }
}

async function withCrossProcessLock<T>(
  path: string,
  action: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try {
    release = await lock(path, {
      realpath: false,
      stale: 10_000,
      update: 3_000,
      retries: {
        retries: Math.ceil(timeoutMs / 40),
        factor: 1,
        minTimeout: 40,
        maxTimeout: 40,
        randomize: false,
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Error(`another codex-multi operation holds ${path}`, {
        cause: error,
      });
    }
    throw error;
  }

  try {
    return await action();
  } finally {
    try {
      await release();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERELEASED") {
        throw error;
      }
    }
  }
}

export async function withFileLocks<T>(
  paths: string[],
  action: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(paths)].sort();
  const acquire = async (index: number): Promise<T> => {
    const path = ordered[index];
    if (!path) return await action();
    return await withFileLock(path, async () => await acquire(index + 1));
  };
  return await acquire(0);
}

export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
