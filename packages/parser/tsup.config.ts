import { defineConfig } from "tsup";

export default defineConfig([
  // Universal APIs
  {
    entry: {
      index: "src/index.ts",
      v5: "src/v5/index.ts",
      v6: "src/v6/index.ts",
      community: "src/community/index.ts",
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
