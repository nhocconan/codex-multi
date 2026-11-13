import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname } from "node:path";

async function renameReplacement(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (process.platform !== "win32" || attempt >= 10 ||
        !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
      // Windows can briefly deny replacement while another file handle closes.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function atomicWrite(
  path: string,
  content: Uint8Array | string,
  mode = 0o600,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", mode);
  try {
    try {
      await handle.writeFile(content);
      if (process.platform !== "win32") await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    await renameReplacement(temporary, path);
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function atomicWriteIfChanged(
  path: string,
  content: Uint8Array | string,
  mode = 0o600,
): Promise<void> {
  if (await matchesPrivateFile(path, content, mode)) return;
  await atomicWrite(path, content, mode);
}

async function matchesPrivateFile(path: string, content: Uint8Array | string, mode: number): Promise<boolean> {
  try {
    const expected = Buffer.from(content);
    const before = await fs.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== expected.length ||
      (process.platform !== "win32" && (before.mode & 0o7777) !== mode)) return false;
    const handle = await fs.open(path, constants.O_RDONLY | (process.platform === "win32"
      ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.length || stat.dev !== before.dev || stat.ino !== before.ino ||
        (process.platform !== "win32" && (stat.mode & 0o7777) !== mode)) return false;
      const actual = Buffer.alloc(expected.length + 1);
      let length = 0;
      while (length < actual.length) {
        const { bytesRead } = await handle.read(actual, length, actual.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await fs.lstat(path);
      return after.isFile() && after.nlink === 1 && after.dev === stat.dev && after.ino === stat.ino &&
        (process.platform === "win32" || (after.mode & 0o7777) === mode) &&
        actual.subarray(0, length).equals(expected);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}
