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
  process.stdout.write(formatPrompt(question, defaultValue));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise<string>((resolve) => {
    rl.question("> ", (answer) => {
      rl.close();
      const value = answer.trim();
      resolve(value || defaultValue || "");
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

  return await new Promise((resolve) => {
    const lineCount = choices.length + 4;
    let rendered = false;
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
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      if (rendered) output.write(`\x1b[${lineCount}A\x1b[J`);
    };
    const onData = (buffer: Buffer): void => {
      const key = buffer.toString();
      if (key === "\x03" || key === "\x1b" || key === "q") {
        cleanup();
        resolve({ ok: false });
      } else if (key === "\x1b[A" || key === "k") {
        selected = (selected - 1 + choices.length) % choices.length;
        render();
      } else if (key === "\x1b[B" || key === "j") {
        selected = (selected + 1) % choices.length;
        render();
      } else if (key === "\r" || key === "\n") {
        const index = selected;
        cleanup();
        resolve({ ok: true, index });
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    render();
  });
}
