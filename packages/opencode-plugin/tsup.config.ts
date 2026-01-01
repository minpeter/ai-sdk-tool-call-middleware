import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    provider: "src/provider.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  noExternal: ["@ai-sdk-tool/parser"],
  external: ["@opencode-ai/plugin", "@ai-sdk/openai-compatible", "ai"],
});
