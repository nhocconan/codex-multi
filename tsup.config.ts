import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  .version as string;

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  sourcemap: true,
  splitting: false,
  // Desktop aliases keep a durable snapshot outside ephemeral npx caches.
  noExternal: ["cross-spawn", "proper-lockfile", "pngjs"],
  define: {
    __PACKAGE_VERSION__: JSON.stringify(packageVersion),
  },
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
});
