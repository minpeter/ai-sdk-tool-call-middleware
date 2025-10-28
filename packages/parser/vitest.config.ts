import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Automatically detect CI environment and disable watch mode
    watch: false,
    include: [
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "tests/**/*.test.ts",
      "tests/**/*.spec.ts",
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      clean: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "**/*.d.ts"],
    },
    // Ensure proper module resolution
    environment: "node",
    globals: true,
  },
  // Ensure ESM compatibility
  resolve: {
    conditions: ["node", "import", "module", "require"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
