import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";

const execFileAsync = promisify(execFile);

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Extract the largest square PNG member from an Apple .icns container.
 * Returns null for icons that only carry legacy (non-PNG) encodings.
 */
export function extractLargestPng(icns: Buffer): { png: Buffer; size: number } | null {
  if (icns.length < 8 || icns.readUInt32BE(0) !== 0x69636e73) return null;
  let offset = 8;
  let best: { png: Buffer; size: number } | null = null;
  while (offset + 8 <= icns.length) {
    const length = icns.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > icns.length) break;
    const payload = icns.subarray(offset + 8, offset + length);
    if (payload.length > 24 && payload[0] === 0x89 && payload[1] === 0x50) {
      const width = payload.readUInt32BE(16);
      const height = payload.readUInt32BE(20);
      if (width === height && (!best || width > best.size)) {
        best = { png: Buffer.from(payload), size: width };
      }
    }
    offset += length;
  }
  return best;
}

/**
 * Overlay a solid color badge with a light ring in the bottom-right corner of
 * a square icon, preserving pixels outside the badge. Returns a new PNG buffer.
 */
export function drawBadge(png: Buffer, color: Rgb): Buffer {
  const image = PNG.sync.read(png);
  const size = image.width;
  const radius = Math.max(4, Math.round(size * 0.22));
  const center = size - radius - Math.max(2, Math.round(size * 0.07));
  const ringWidth = Math.max(1, Math.round(size * 0.025));
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      const fill = coverage(radius - ringWidth, distance);
      const total = coverage(radius, distance);
      if (fill <= 0 && total <= 0) continue;
      const index = (size * y + x) << 2;
      const alpha = data[index + 3]!;
      // White ring first, then the color core, both over the original pixel.
      const ringAlpha = total * 255;
      const fillAlpha = fill * 255;
      let r = blend(data[index]!, alpha, 255, ringAlpha);
      let g = blend(data[index + 1]!, alpha, 255, ringAlpha);
      let b = blend(data[index + 2]!, alpha, 255, ringAlpha);
      let a = ringAlpha + alpha * (1 - ringAlpha / 255);
      r = blend(r, a, color.r, fillAlpha);
      g = blend(g, a, color.g, fillAlpha);
      b = blend(b, a, color.b, fillAlpha);
      a = fillAlpha + a * (1 - fillAlpha / 255);
      data[index] = clampByte(r);
      data[index + 1] = clampByte(g);
      data[index + 2] = clampByte(b);
      data[index + 3] = clampByte(a);
    }
  }
  return PNG.sync.write(image);
}

function blend(base: number, baseAlpha: number, over: number, overAlpha: number): number {
  if (overAlpha <= 0) return base;
  return (base * baseAlpha * (255 - overAlpha) + over * overAlpha * 255) / (baseAlpha * (255 - overAlpha) + overAlpha * 255);
}

function coverage(radius: number, distance: number): number {
  return Math.min(1, Math.max(0, radius + 0.5 - distance));
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** Halve a PNG's dimensions with a premultiplied-alpha 2x2 box filter. */
export function halveImage(png: Buffer): Buffer {
  const image = PNG.sync.read(png);
  if (image.width < 2 || image.height < 2) return PNG.sync.write(image);
  const width = image.width >> 1;
  const height = image.height >> 1;
  const out = new PNG({ width, height });
  const source = image.data;
  const target = out.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (width * y + x) << 2;
      const samples = [
        ((y * 2) * image.width + x * 2) * 4,
        ((y * 2) * image.width + x * 2 + 1) * 4,
        ((y * 2 + 1) * image.width + x * 2) * 4,
        ((y * 2 + 1) * image.width + x * 2 + 1) * 4,
      ];
      const alpha = samples.reduce((sum, sample) => sum + source[sample + 3]!, 0);
      for (let channel = 0; channel < 3; channel++) {
        const weighted = samples.reduce((sum, sample) => sum + source[sample + channel]! * source[sample + 3]!, 0);
        target[index + channel] = alpha ? clampByte(weighted / alpha) : 0;
      }
      target[index + 3] = clampByte(alpha / 4);
    }
  }
  return PNG.sync.write(out);
}

/** Produce every standard iconset PNG size available from one large square PNG. */
export function iconsetPngs(largest: Buffer, size: number): Array<{ name: string; png: Buffer }> {
  const bySize = new Map<number, Buffer>();
  let current = largest;
  let currentSize = size;
  while (currentSize >= 16) {
    bySize.set(currentSize, current);
    if (currentSize < 32) break;
    current = halveImage(current);
    currentSize >>= 1;
  }
  const wanted: Array<[number, string]> = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  const files: Array<{ name: string; png: Buffer }> = [];
  for (const [pixelSize, name] of wanted) {
    const png = bySize.get(pixelSize);
    if (png) files.push({ name, png });
  }
  return files;
}

/**
 * Render a color-badged .icns from an existing .icns. Returns null whenever a
 * badged icon cannot be produced (missing iconutil, unparsable icon, or a
 * non-macOS host); callers fall back to the unmodified original icon.
 */
export async function renderBadgedIcns(
  sourceIcnsPath: string,
  color: Rgb,
): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;
  if (process.env.CODEX_MULTI_NO_NATIVE_TOOLS === "1") return null;
  let source: { png: Buffer; size: number } | null;
  try {
    source = extractLargestPng(await fs.readFile(sourceIcnsPath));
  } catch {
    return null;
  }
  if (!source || source.size < 32) return null;

  const iconset = join(tmpdir(), `codex-multi-icon-${process.pid}-${Date.now()}.iconset`);
  const destination = iconset.replace(/\.iconset$/, ".icns");
  try {
    const badged = drawBadge(source.png, color);
    await fs.mkdir(iconset, { recursive: true });
    for (const file of iconsetPngs(badged, source.size)) {
      await fs.writeFile(join(iconset, file.name), file.png);
    }
    await execFileAsync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", destination]);
    return await fs.readFile(destination);
  } catch {
    return null;
  } finally {
    await fs.rm(iconset, { recursive: true, force: true }).catch(() => {});
    await fs.rm(destination, { force: true }).catch(() => {});
  }
}
