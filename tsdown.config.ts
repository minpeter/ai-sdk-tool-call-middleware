import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    community: "src/community/index.ts",
    rxml: "src/rxml/index.ts",
    rjson: "src/rjson/index.ts",
    "schema-coerce": "src/schema-coerce/index.ts",
  },
  format: "esm",
  fixedExtension: false,
  // TypeScript 7 has no stable Compiler API; declarations are emitted by tsc.
  dts: false,
  sourcemap: true,
  target: "es2018",
  platform: "node",
  define: {
    __PACKAGE_VERSION__: JSON.stringify(
      (await import("./package.json", { with: { type: "json" } })).default
        .version
    ),
  },
});
