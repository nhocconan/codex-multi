import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
type Value = string | Record<string, unknown> | unknown[] | number | boolean | null;

function invalid(): never {
  throw new Error("Invalid or unsupported property list");
}

function decode(text: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) invalid();
  return text.replace(/&([^;]*);|&/g, (whole, entity: string | undefined) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity !== undefined && Object.hasOwn(named, entity)) return named[entity]!;
    if (!entity || !/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) invalid();
    const code = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) invalid();
    return String.fromCodePoint(code);
  });
}

/** Parse the plist grammar, never scanning nested values or comments for keys. */
export function parsePlistStrings(xml: string): Record<string, string> {
  if (Buffer.byteLength(xml, "utf8") > MAX_BYTES) invalid();
  xml = xml.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let offset = 0;
  const comment = (): boolean => {
    if (!xml.startsWith("<!--", offset)) return false;
    const end = xml.indexOf("-->", offset + 4);
    if (end < 0 || xml.slice(offset + 4, end).includes("--") || xml[end - 1] === "-") invalid();
    offset = end + 3;
    return true;
  };
  const whitespace = (): void => {
    while (true) {
      const match = /^[\t\n ]*/.exec(xml.slice(offset))!;
      offset += match[0].length;
      if (!comment()) break;
    }
  };
  if (xml.startsWith("<?xml", offset)) {
    const declaration = /^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])(?:UTF-8|utf-8)\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/.exec(xml);
    if (!declaration) invalid();
    offset += declaration[0].length;
  }
  whitespace();
  if (xml.startsWith("<!DOCTYPE", offset)) {
    const doctype = /^<!DOCTYPE\s+plist\s+PUBLIC\s+(["'])-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN\1\s+(["'])https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd\2\s*>/.exec(xml.slice(offset));
    if (!doctype) invalid();
    offset += doctype[0].length;
  }
  whitespace();
  const root = /^<plist(?:\s+version\s*=\s*(["'])1\.0\1)?\s*>/.exec(xml.slice(offset));
  if (!root) invalid();
  offset += root[0].length;
  const element = (depth: number, expectKey = false): Value => {
    if (depth > MAX_DEPTH) invalid();
    whitespace();
    const opening = /^<(key|string|dict|array|data|date|integer|real|true|false)\s*(\/?)>/.exec(xml.slice(offset));
    if (!opening) invalid();
    const name = opening[1]!;
    if (expectKey !== (name === "key")) invalid();
    offset += opening[0].length;
    const empty = opening[2] === "/";
    const close = `</${name}>`;
    if (name === "dict" || name === "array") {
      const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const items: unknown[] = [];
      if (!empty) {
        whitespace();
        while (!xml.startsWith(close, offset)) {
          if (name === "dict") {
            const key = element(depth + 1, true) as string;
            if (Object.hasOwn(values, key)) invalid();
            values[key] = element(depth + 1);
          } else items.push(element(depth + 1));
          whitespace();
        }
        offset += close.length;
      }
      return name === "dict" ? values : items;
    }
    let content = "";
    if (!empty) {
      while (!xml.startsWith(close, offset)) {
        if (comment()) continue;
        const next = xml.indexOf("<", offset);
        if (next < 0 || next === offset) invalid();
        const text = xml.slice(offset, next);
        if (text.includes("]]>")) invalid();
        content += decode(text);
        offset = next;
      }
      offset += close.length;
    }
    if (name === "key" || name === "string") return content;
    if (name === "true" || name === "false") {
      if (content.trim()) invalid();
      return name === "true";
    }
    if (name === "integer" && !/^[+-]?(?:\d+|0x[0-9a-fA-F]+)$/.test(content.trim())) invalid();
    if (name === "real" && !/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/i.test(content.trim())) invalid();
    if (name === "date" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(content.trim())) invalid();
    if (name === "data" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content.replace(/\s/g, ""))) invalid();
    return null;
  };
  whitespace();
  if (!/^<dict\s*(?:\/?)>/.test(xml.slice(offset))) invalid();
  const values = element(0) as Record<string, unknown>;
  whitespace();
  if (!xml.startsWith("</plist>", offset)) invalid();
  offset += "</plist>".length;
  whitespace();
  if (offset !== xml.length) invalid();
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export async function readPlistValues(path: string): Promise<Record<string, string>> {
  const file = await fs.readFile(path);
  if (file.length > MAX_BYTES) invalid();
  if (file.subarray(0, 8).equals(Buffer.from("bplist00"))) {
    if (process.platform !== "darwin") invalid();
    const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", resolve(path)], {
      maxBuffer: MAX_BYTES,
      timeout: 5000,
    });
    return parsePlistStrings(stdout);
  }
  return parsePlistStrings(new TextDecoder("utf-8", { fatal: true }).decode(file));
}
