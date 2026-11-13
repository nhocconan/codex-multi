import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, promptLine, select } from "../src/ui.ts";

let input: PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };
let output: PassThrough;

beforeEach(() => {
  input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((raw: boolean) => { input.isRaw = raw; }),
  });
  output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  output.resume();
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(output as unknown as typeof process.stdout);
});

afterEach(() => {
  vi.restoreAllMocks();
  input.destroy();
  output.destroy();
});

describe("interactive prompt lifecycle", () => {
  it("accepts a line and applies the default only after Enter", async () => {
    const answer = promptLine("Name", "Work");
    input.write("\n");
    await expect(answer).resolves.toBe("Work");
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it.each(["eof", "interrupt"])("cancels a prompt on %s without accepting its default", async (event) => {
    const answer = promptLine("Name", "Work");
    const assertion = expect(answer).rejects.toThrow("cancelled");
    if (event === "eof") input.end();
    else input.write("\x03");
    await assertion;
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.isRaw).toBe(false);
  });

  it.each([["yes\n", true], ["no\n", false], ["\n", false]] as const)("requires a positive answer to confirmation %j", async (line, accepted) => {
    const answer = confirm("Remove Work?");
    input.write(line);
    await expect(answer).resolves.toBe(accepted);
  });

  it("fails promptly without a terminal", async () => {
    input.isTTY = false;
    await expect(promptLine("Profile name")).rejects.toThrow("interactive terminal");
    await expect(select(["Work"], "Profiles")).rejects.toThrow("interactive terminal");
    expect(input.listenerCount("data")).toBe(0);
  });

  it("cancels without opening a prompt after input has closed", async () => {
    input.destroy();
    await expect(promptLine("Name", "Work")).rejects.toThrow("cancelled");
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("rejects an input failure and leaves raw mode", async () => {
    const answer = promptLine("Name", "Work");
    const assertion = expect(answer).rejects.toThrow("terminal disconnected");
    input.emit("error", new Error("terminal disconnected"));
    await assertion;
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("keypress")).toBe(0);
  });
});

describe("interactive picker lifecycle", () => {
  it("returns the chosen profile and restores terminal state", async () => {
    input.pause();
    const selected = select(["Work", "Personal"], "Profiles");
    input.write("\x1b[B");
    input.write("\r");
    await expect(selected).resolves.toEqual({ ok: true, index: 1 });
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    for (const event of ["data", "end", "close", "error"]) expect(input.listenerCount(event)).toBe(0);
  });

  it.each(["q", "\x1b", "\x03"])("cancels on %j and preserves existing raw mode", async (key) => {
    input.isRaw = true;
    input.resume();
    const selected = select(["Work"], "Profiles");
    input.write(key);
    await expect(selected).resolves.toEqual({ ok: false });
    expect(input.isRaw).toBe(true);
    expect(input.isPaused()).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it.each(["end", "close"])("cancels when the terminal emits %s", async (event) => {
    const selected = select(["Work"], "Profiles");
    input.emit(event);
    await expect(selected).resolves.toEqual({ ok: false });
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.isPaused()).toBe(true);
  });

  it("cleans up and rejects when terminal input fails", async () => {
    const selected = select(["Work"], "Profiles");
    const assertion = expect(selected).rejects.toThrow("terminal disconnected");
    input.emit("error", new Error("terminal disconnected"));
    await assertion;
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("removes its listeners even when restoring raw mode fails", async () => {
    const selected = select(["Work"], "Profiles");
    const assertion = expect(selected).rejects.toThrow("terminal disconnected");
    input.setRawMode.mockImplementation(() => { throw new Error("terminal disconnected"); });
    input.write("q");
    await assertion;
    expect(input.listenerCount("data")).toBe(0);
  });

  it("rejects a failure to enter raw mode without leaving listeners behind", async () => {
    input.setRawMode.mockImplementation(() => { throw new Error("raw mode unavailable"); });
    await expect(select(["Work"], "Profiles")).rejects.toThrow("raw mode unavailable");
    expect(input.listenerCount("data")).toBe(0);
  });

  it("leaves raw mode and removes listeners if rendering fails", async () => {
    const selected = select(["Work", "Personal"], "Profiles");
    const assertion = expect(selected).rejects.toThrow("output disconnected");
    vi.spyOn(output, "write").mockImplementation(() => { throw new Error("output disconnected"); });
    input.write("j");
    await assertion;
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("does not change terminal state for an empty picker", async () => {
    await expect(select([], "Profiles")).resolves.toEqual({ ok: false });
    expect(input.setRawMode).not.toHaveBeenCalled();
  });

  it("cancels without changing raw mode after input has closed", async () => {
    input.destroy();
    await expect(select(["Work"], "Profiles")).resolves.toEqual({ ok: false });
    expect(input.setRawMode).not.toHaveBeenCalled();
  });
});
