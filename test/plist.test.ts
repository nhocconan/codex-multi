import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parsePlistStrings, readPlistValues } from "../src/core/plist.ts";

const wrap = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>`;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("strict property list strings", () => {
  it("returns top-level strings, skipping comments, nested values and other scalar types", () => {
    expect(parsePlistStrings(wrap(`
      <!-- <key>CommentOwner</key><string>spoof</string> -->
      <key>Nested</key><dict><key>NestedOwner</key><string>spoof</string></dict>
      <key>Items</key><array><dict><key>ArrayOwner</key><string>spoof</string></dict><string>ignored</string></array>
      <key>Number</key><integer>123</integer><key>Decimal</key><real>1.25</real>
      <key>Enabled</key><true/><key>Disabled</key><false></false>
      <key>Date</key><date>2026-10-31T00:00:00Z</date><key>Data</key><data>YWJj</data>
      <key>Owner</key><string>real</string><key>Empty</key><string/>
    `))).toEqual({ Owner: "real", Empty: "" });
  });

  it("decodes standard named and numeric XML entities once", () => {
    expect(parsePlistStrings(wrap('<key>A&amp;B</key><string>&lt;&gt;&quot;&apos;&#65;&#x1F600;&amp;lt;</string>')))
      .toEqual({ "A&B": '<>"\'A😀&lt;' });
  });

  it("handles literal prototype property names without changing object prototypes", () => {
    const values = parsePlistStrings(wrap('<key>__proto__</key><string>safe</string><key>constructor</key><string>text</string>'));
    expect(Object.getOwnPropertyDescriptor(values, "__proto__")?.value).toBe("safe");
    expect(values.constructor).toBe("text");
  });

  it.each([
    '<key>Owner</key><string>a</string><key>Owner</key><string>b</string>',
    '<key>Owner</key><integer>1</integer><key>Owner</key><string>b</string>',
    '<key>Nest</key><dict><key>A</key><string>a</string><key>A</key><string>b</string></dict>',
    '<key>A</key><string>&unknown;</string>',
    '<key>A</key><string>&amp</string>',
    '<key>A</key><string>&#0;</string>',
    '<key>A</key><string>&#xD800;</string>',
    '<key>A</key><string>&#x110000;</string>',
    '<key>A</key><string><key>nested</key></string>',
    '<key>A</key><integer>not a number</integer>',
    '<key>A</key><true>yes</true>',
    '<key>A</key><data>bad!</data>',
    '<key>A</key>',
    '<string>value without key</string>',
    '<!-- bad -- comment -->',
    '<key>A</key><string>bad\u0000text</string>',
  ])("rejects malformed/ambiguous values: %s", (body) => {
    expect(() => parsePlistStrings(wrap(body))).toThrow();
  });

  it.each([
    '<!DOCTYPE plist [<!ENTITY owner "spoof">]><plist><dict><key>A</key><string>&owner;</string></dict></plist>',
    '<!DOCTYPE plist SYSTEM "file:///etc/passwd"><plist><dict/></plist>',
    '<plist><dict/></plist><plist><dict/></plist>',
    '<plist><array/></plist>',
    '<plist><dict><key>A</key><string>x</string></array></plist>',
    '<plist><dict/></plist>junk',
  ])("rejects malformed documents and custom DTDs", (xml) => {
    expect(() => parsePlistStrings(xml)).toThrow();
  });

  it("rejects oversized and deeply nested input", () => {
    expect(() => parsePlistStrings(wrap(`<key>A</key><string>${"a".repeat(1024 * 1024)}</string>`))).toThrow();
    expect(() => parsePlistStrings(wrap(`<key>A</key>${"<array>".repeat(70)}${"</array>".repeat(70)}`))).toThrow();
  });

  it("reads XML directly and rejects invalid UTF-8 without native fallback", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "cpm-plist-"));
    directories.push(directory);
    const path = join(directory, "Info.plist");
    await fs.writeFile(path, wrap('<key>Owner</key><string>real</string>'));
    expect(await readPlistValues(path)).toEqual({ Owner: "real" });
    await fs.writeFile(path, Buffer.concat([Buffer.from(wrap("")), Buffer.from([0xff])]));
    await expect(readPlistValues(path)).rejects.toThrow();
  });

  it.skipIf(process.platform !== "darwin")("reads Apple-generated binary plists while retaining scalar types", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "cpm-plist-"));
    directories.push(directory);
    const path = join(directory, "Info.plist");
    await fs.writeFile(path, wrap('<key>Owner</key><string>A&amp;B</string><key>Count</key><integer>123</integer>'));
    await promisify(execFile)("/usr/bin/plutil", ["-convert", "binary1", path]);
    expect(await readPlistValues(path)).toEqual({ Owner: "A&B" });
    await fs.writeFile(path, Buffer.from("bplist00invalid"));
    await expect(readPlistValues(path)).rejects.toThrow();
  });
});
