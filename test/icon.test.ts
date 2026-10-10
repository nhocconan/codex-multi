import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import {
  drawBadge,
  extractLargestPng,
  halveImage,
  iconsetPngs,
  renderBadgedIcns,
  type Rgb,
} from "../src/core/icon.ts";
import {
  DESKTOP_COLORS,
  desktopColorFor,
  validDesktopColor,
} from "../src/core/desktop.ts";

const RED: Rgb = { r: 229, g: 72, b: 77 };
const nativeExec = vi.hoisted(() => vi.fn<(
  command: string,
  args: readonly string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void>());
vi.mock("node:child_process", () => ({ execFile: nativeExec }));

function solidPng(size: number, rgba: [number, number, number, number]): Buffer {
  const image = new PNG({ width: size, height: size });
  for (let index = 0; index < size * size; index++) {
    image.data.set(rgba, index << 2);
  }
  return PNG.sync.write(image);
}

function icnsContainer(entries: Array<{ type: string; payload: Buffer }>): Buffer {
  let total = 8;
  const encoded = entries.map((entry) => {
    const body = Buffer.concat([
      Buffer.from(entry.type, "ascii"),
      Buffer.alloc(4),
      entry.payload,
    ]);
    body.writeUInt32BE(body.length, 4);
    total += body.length;
    return body;
  });
  const header = Buffer.alloc(4);
  header.writeUInt32BE(total, 0);
  return Buffer.concat([Buffer.from("icns", "ascii"), header, ...encoded]);
}

function pixel(png: Buffer, x: number, y: number): [number, number, number, number] {
  const image = PNG.sync.read(png);
  const index = (image.width * y + x) << 2;
  return [
    image.data[index]!,
    image.data[index + 1]!,
    image.data[index + 2]!,
    image.data[index + 3]!,
  ];
}

describe("icns extraction", () => {
  it("picks the largest square PNG member", () => {
    const icns = icnsContainer([
      { type: "ic07", payload: solidPng(64, [1, 2, 3, 255]) },
      { type: "ic09", payload: solidPng(128, [4, 5, 6, 255]) },
    ]);
    const extracted = extractLargestPng(icns);
    expect(extracted?.size).toBe(128);
    expect(pixel(extracted!.png, 10, 10)).toEqual([4, 5, 6, 255]);
  });

  it("rejects non-icns data and icns without PNG members", () => {
    expect(extractLargestPng(Buffer.from("not an icon"))).toBeNull();
    expect(extractLargestPng(icnsContainer([{ type: "ic07", payload: Buffer.from([1, 2, 3]) }]))).toBeNull();
  });
});

describe("icon badge", () => {
  it("paints a solid badge without touching the rest of the icon", () => {
    const badged = drawBadge(solidPng(100, [255, 255, 255, 255]), RED);
    const [br, bg, bb] = pixel(badged, 78, 78);
    expect(Math.abs(br - RED.r)).toBeLessThanOrEqual(2);
    expect(Math.abs(bg - RED.g)).toBeLessThanOrEqual(2);
    expect(Math.abs(bb - RED.b)).toBeLessThanOrEqual(2);
    expect(pixel(badged, 5, 5)).toEqual([255, 255, 255, 255]);
  });

  it("keeps transparent regions transparent outside the badge", () => {
    const badged = drawBadge(solidPng(100, [0, 0, 0, 0]), RED);
    expect(pixel(badged, 5, 5)[3]).toBe(0);
    const [, , , badgeAlpha] = pixel(badged, 78, 78);
    expect(badgeAlpha).toBe(255);
  });

  it("uses a substantial color disk and a contrasting ring at Dock size", () => {
    const badged = drawBadge(solidPng(100, [0, 0, 0, 255]), RED);
    expect(pixel(badged, 54, 71)).toEqual([RED.r, RED.g, RED.b, 255]);
    expect(pixel(badged, 51, 71)).toEqual([255, 255, 255, 255]);
  });

  it("composites antialiased edges over translucent original pixels", () => {
    const badged = drawBadge(solidPng(100, [0, 0, 0, 128]), RED);
    const ringAlpha = (22.5 - Math.hypot(49.5 - 71, 65.5 - 71)) * 255;
    const alpha = ringAlpha + 128 * (1 - ringAlpha / 255);
    const channel = Math.round(255 * ringAlpha / alpha);
    expect(pixel(badged, 49, 65)).toEqual([channel, channel, channel, Math.round(alpha)]);
  });
});

describe("icon scaling", () => {
  it("halves dimensions and averages pixels", () => {
    const image = new PNG({ width: 8, height: 8 });
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const index = (8 * y + x) << 2;
        image.data[index] = x < 4 ? 255 : 0;
        image.data[index + 1] = 255;
        image.data[index + 2] = 255;
        image.data[index + 3] = 255;
      }
    }
    const halved = PNG.sync.read(halveImage(PNG.sync.write(image)));
    expect(halved.width).toBe(4);
    expect(pixel(PNG.sync.write(halved), 0, 0)[0]).toBeGreaterThanOrEqual(252);
    expect(pixel(PNG.sync.write(halved), 2, 0)[0]).toBeLessThanOrEqual(3);
  });

  it("emits the standard iconset names for available sizes", () => {
    const files = iconsetPngs(solidPng(256, [9, 9, 9, 255]), 256);
    const names = files.map((file) => file.name);
    expect(names).toContain("icon_16x16.png");
    expect(names).toContain("icon_256x256.png");
    expect(names).toContain("icon_128x128@2x.png");
    expect(names).not.toContain("icon_512x512.png"); // a 256px source cannot supply it
    for (const file of files) {
      const match = /^icon_(\d+)x\1\.png$/.exec(file.name);
      if (match) expect(PNG.sync.read(file.png).width).toBe(Number(match[1]));
    }
  });

  it("ignores hidden RGB in transparent pixels when shrinking an icon edge", () => {
    const image = new PNG({ width: 2, height: 2 });
    image.data.set([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0]);
    expect(pixel(halveImage(PNG.sync.write(image)), 0, 0)).toEqual([255, 0, 0, 64]);
  });
});

describe("color assignment", () => {
  it("is stable per slug and distinct for the documented examples", () => {
    const profile = (slug: string) => ({ slug, label: slug, createdAt: "2026-01-01" });
    expect(desktopColorFor(profile("cnbk"))).toBe(desktopColorFor(profile("cnbk")));
    const colors = new Set(["cnbk", "student", "teacher"].map((slug) => desktopColorFor(profile(slug))));
    expect(colors.size).toBe(3);
    for (const color of colors) {
      expect(color === "none" || color in DESKTOP_COLORS).toBe(true);
    }
  });

  it("honors explicit choices and validates input", () => {
    const profile = {
      slug: "work",
      label: "Work",
      createdAt: "2026-01-01",
      desktop: { enabled: true, appPath: "/x", appName: "ChatGPT", color: "purple" },
    };
    expect(desktopColorFor(profile)).toBe("purple");
    expect(validDesktopColor("auto")).toBe(true);
    expect(validDesktopColor("none")).toBe(true);
    expect(validDesktopColor("teal")).toBe(true);
    expect(validDesktopColor("mauve")).toBe(false);
  });
});

describe("badged icns rendering", () => {
  let root = "";
  const savedTools = process.env.CODEX_MULTI_NO_NATIVE_TOOLS;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "cpm-icon-"));
    process.env.CODEX_MULTI_NO_NATIVE_TOOLS = "1";
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    nativeExec.mockReset();
  });

  afterEach(async () => {
    if (savedTools === undefined) delete process.env.CODEX_MULTI_NO_NATIVE_TOOLS;
    else process.env.CODEX_MULTI_NO_NATIVE_TOOLS = savedTools;
    Object.defineProperty(process, "platform", platformDescriptor);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("falls back to null without native tools, keeping the original icon safe", async () => {
    const source = join(root, "app.icns");
    await fs.writeFile(source, icnsContainer([{ type: "ic09", payload: solidPng(128, [1, 2, 3, 255]) }]));
    expect(await renderBadgedIcns(source, RED)).toBeNull();
    expect(nativeExec).not.toHaveBeenCalled();
  });

  it("falls back when a PNG member has a valid header but cannot be decoded", async () => {
    delete process.env.CODEX_MULTI_NO_NATIVE_TOOLS;
    const malformed = solidPng(128, [1, 2, 3, 255]).subarray(0, 25);
    const original = icnsContainer([{ type: "ic09", payload: malformed }]);
    const source = join(root, "malformed.icns");
    await fs.writeFile(source, original);
    await expect(renderBadgedIcns(source, RED)).resolves.toBeNull();
    expect(await fs.readFile(source)).toEqual(original);
    expect(nativeExec).not.toHaveBeenCalled();
  });

  it("returns the native icon output and removes temporary files", async () => {
    delete process.env.CODEX_MULTI_NO_NATIVE_TOOLS;
    const source = join(root, "app.icns");
    const original = icnsContainer([{ type: "ic09", payload: solidPng(128, [1, 2, 3, 255]) }]);
    await fs.writeFile(source, original);
    const output = Buffer.from("native icon output");
    let iconset = "";
    let destination = "";
    nativeExec.mockImplementation((_command, args, callback) => {
      iconset = args[2]!;
      destination = args[4]!;
      void fs.readFile(join(iconset, "icon_128x128.png")).then(async (badged) => {
        expect(pixel(badged, 91, 91)).toEqual([RED.r, RED.g, RED.b, 255]);
        await fs.writeFile(destination, output);
        callback(null, "", "");
      }).catch((error: Error) => callback(error, "", ""));
    });
    expect(await renderBadgedIcns(source, RED)).toEqual(output);
    expect(nativeExec).toHaveBeenCalledWith("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", destination], expect.any(Function));
    await expect(fs.stat(iconset)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(source)).toEqual(original);
  });

  it("falls back and cleans up when iconutil fails", async () => {
    delete process.env.CODEX_MULTI_NO_NATIVE_TOOLS;
    const source = join(root, "app.icns");
    await fs.writeFile(source, icnsContainer([{ type: "ic09", payload: solidPng(128, [1, 2, 3, 255]) }]));
    let iconset = "";
    nativeExec.mockImplementation((_command, args, callback) => {
      iconset = args[2]!;
      callback(new Error("iconutil unavailable"), "", "");
    });
    await expect(renderBadgedIcns(source, RED)).resolves.toBeNull();
    await expect(fs.stat(iconset)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
