import { createInterface } from "node:readline";

function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function requireInteractive(action: string): void {
  if (interactive()) return;
  throw new Error(`${action} requires an interactive terminal; pass the required flags instead`);
}

export function formatPrompt(question: string, defaultValue?: string): string {
  return `${question}${defaultValue === undefined ? "" : ` [${defaultValue}]`}\n`;
}

export async function promptLine(question: string, defaultValue?: string): Promise<string> {
  requireInteractive(question);
  if (process.stdin.destroyed || process.stdin.readableEnded) throw new Error("cancelled");
  process.stdout.write(formatPrompt(question, defaultValue));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch { /* The terminal may already be disconnected. */ }
      reject(error);
    };
    const cancel = (): void => {
      fail(new Error("cancelled"));
    };
    rl.once("close", cancel);
    rl.once("SIGINT", cancel);
    rl.once("error", fail);
    rl.question("> ", (answer) => {
      settled = true;
      const value = answer.trim();
      try {
        rl.close();
        resolve(value || defaultValue || "");
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await promptLine(`${question} [y/N]`);
  return /^(?:y|yes)$/i.test(answer);
}

export async function select(
  choices: string[],
  header: string,
): Promise<{ ok: true; index: number } | { ok: false }> {
  if (choices.length === 0) return { ok: false };
  requireInteractive(header);
  let selected = 0;
  const input = process.stdin;
  const output = process.stdout;
  if (input.destroyed || input.readableEnded) return { ok: false };
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;

  return await new Promise((resolve, reject) => {
    const lineCount = choices.length + 4;
    let rendered = false;
    let settled = false;
    const render = (): void => {
      if (rendered) output.write(`\x1b[${lineCount}A`);
      output.write("\x1b[J");
      output.write(`${header}\n\n`);
      choices.forEach((choice, index) => {
        const active = index === selected;
        output.write(active ? `\x1b[36m❯ ${choice}\x1b[0m\n` : `  ${choice}\n`);
      });
      output.write("\n\x1b[2m↑/↓ or j/k · Enter · Esc/q\x1b[0m\n");
      rendered = true;
    };
    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      if (rendered) output.write(`\x1b[${lineCount}A\x1b[J`);
    };
    const finish = (result: { ok: true; index: number } | { ok: false }): void => {
      if (settled) return;
      settled = true;
      try {
        cleanup();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    const onEnd = (): void => finish({ ok: false });
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      try { cleanup(); } catch { /* Keep the original terminal error. */ }
      reject(error);
    };
    const onData = (buffer: Buffer): void => {
      try {
        const key = buffer.toString();
        if (key === "\x03" || key === "\x1b" || key === "q") {
          finish({ ok: false });
        } else if (key === "\x1b[A" || key === "k") {
          selected = (selected - 1 + choices.length) % choices.length;
          render();
        } else if (key === "\x1b[B" || key === "j") {
          selected = (selected + 1) % choices.length;
          render();
        } else if (key === "\r" || key === "\n") {
          const index = selected;
          finish({ ok: true, index });
        }
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    };
    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("close", onEnd);
      input.once("error", onError);
      input.resume();
      render();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
