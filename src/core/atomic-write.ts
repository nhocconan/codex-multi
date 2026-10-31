import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
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
