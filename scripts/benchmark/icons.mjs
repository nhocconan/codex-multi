import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import ts from "typescript";
import { PNG } from "pngjs";

const filename = resolve("src/core/icon.ts");
const require = createRequire(filename);
function load(source) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)(require, exports);
  return exports;
}

const baseline = process.argv[2] ?? "HEAD";
const before = load(execFileSync("git", ["show", `${baseline}:src/core/icon.ts`], { encoding: "utf8" }));
const after = load(readFileSync(filename, "utf8"));
const image = new PNG({ width: 1024, height: 1024 });
for (let i = 0; i < image.data.length; i++) image.data[i] = (i * 17 + (i >> 9)) & 255;
const png = PNG.sync.write(image);
const color = { r: 62, g: 99, b: 221 };
const render = module => module.iconsetPngs(module.drawBadge(png, color), 1024);
const expected = render(before);
assert.deepEqual(render(after), expected, "optimized icon pipeline changed pixels or iconset names");

for (let i = 0; i < 3; i++) { render(before); render(after); }
const times = { before: [], after: [] };
for (let i = 0; i < 12; i++) {
  for (const [name, module] of i % 2 ? [["after", after], ["before", before]] : [["before", before], ["after", after]]) {
    const start = performance.now();
    render(module);
    times[name].push(performance.now() - start);
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const oldMs = median(times.before);
const newMs = median(times.after);
console.log(JSON.stringify({ baseline, size: 1024, samples: 12, identicalOutput: true,
  beforeMedianMs: +oldMs.toFixed(2), afterMedianMs: +newMs.toFixed(2),
  reductionPercent: +((1 - newMs / oldMs) * 100).toFixed(1) }, null, 2));
