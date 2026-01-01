import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "reasoning-parser": "src/reasoning-parser.ts",
      "disk-cache": "src/disk-cache.ts",
    },
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    target: "es2018",
    platform: "node",
    define: {
      __PACKAGE_VERSION__: JSON.stringify(
        (await import("./package.json", { with: { type: "json" } })).default
          .version
      ),
    },
  },
]);
