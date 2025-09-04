import { defineConfig } from "tsup";

export default defineConfig([
  {
    dts: true,
    entry: {
      index: "src/index.ts",
      community: "src/community/index.ts",
    },
    format: ["cjs", "esm"],
    sourcemap: true,
  },
]);
