import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Bundle the public entry so ESM output has no relative extensionless imports
    bundle: true,
    dts: true,
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    sourcemap: true,
    target: "es2022",
    splitting: false,
    clean: true,
    outDir: "dist",
    skipNodeModulesBundle: true,
  },
]);
