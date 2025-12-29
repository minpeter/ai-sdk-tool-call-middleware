import { defineConfig } from "tsup";

export default defineConfig([
  // Universal APIs
  {
    entry: {
      index: "src/index.ts",
    },
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    target: "es2018",
    platform: "node",
    clean: true,
    external: ["fastify", "@fastify/cors"],
    define: {
      __PACKAGE_VERSION__: JSON.stringify(
        (await import("./package.json", { with: { type: "json" } })).default
          .version
      ),
    },
  },
]);
