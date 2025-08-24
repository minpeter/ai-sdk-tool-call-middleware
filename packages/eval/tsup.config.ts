import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Preserve file structure like tsc (no bundling) so import.meta.url based paths stay valid
    bundle: false,
    dts: true,
    entry: ["src/**/*.ts"],
    format: ["cjs", "esm"],
    sourcemap: true,
    target: "es2022",
    splitting: false,
    clean: true,
    outDir: "dist",
    skipNodeModulesBundle: true,
  },
]);
