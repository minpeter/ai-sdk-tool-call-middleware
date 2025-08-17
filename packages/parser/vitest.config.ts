import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Automatically detect CI environment and disable watch mode
    watch: false,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
    },
    // Ensure proper module resolution
    environment: "node",
    globals: true,
  },
  // Ensure ESM compatibility
  resolve: {
    conditions: ["node", "import", "module", "require"],
  },
});
