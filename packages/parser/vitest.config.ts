import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Automatically detect CI environment and disable watch mode
    include: ["src/**/*.test.ts"], // DO NOT CHANGE THIS
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "html"],
      exclude: ["src/index.ts", "src/utils/index.ts"],
    },
  },
  // Ensure ESM compatibility
  resolve: {
    conditions: ["node", "import", "module", "require"],
  },
});
