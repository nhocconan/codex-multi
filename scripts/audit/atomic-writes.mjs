import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(process.argv[2] ?? "src");
let violations = 0;

async function scan(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const source = ts.createSourceFile(path, await fs.readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    const scopes = new Map();
    const visit = (node, scope) => {
      if (ts.isFunctionLike(node)) scope = node;
      if (ts.isCallExpression(node)) {
        const name = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text : node.expression.getText(source);
        const first = node.arguments[0];
        if (["writeFile", "rename"].includes(name) && first && ts.isIdentifier(first)) {
          const rows = scopes.get(scope) ?? [];
          rows.push({ name, target: first.text, node });
          scopes.set(scope, rows);
        }
      }
      ts.forEachChild(node, (child) => visit(child, scope));
    };
    visit(source, source);
    for (const rows of scopes.values()) {
      const renamed = new Set(rows.filter((row) => row.name === "rename").map((row) => row.target));
      for (const row of rows) {
        if (row.name !== "writeFile" || !renamed.has(row.target)) continue;
        const line = source.getLineAndCharacterOfPosition(row.node.getStart(source)).line + 1;
        console.error(`${relative(process.cwd(), path)}:${line}: unsafe temporary write; use atomicWrite() for replacement files (AGENTS.md security rule 1)`);
        violations++;
      }
    }
  }
}

await scan(root);
if (violations > 0) process.exitCode = 1;
else console.log("Atomic write audit passed.");
