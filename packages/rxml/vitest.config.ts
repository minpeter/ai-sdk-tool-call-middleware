import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Automatically detect CI environment and disable watch mode
    watch: !process.env.CI,
    include: [
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "tests/**/*.test.ts",
      "tests/**/*.spec.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      enabled: true,
      clean: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "**/*.d.ts"],
    },
    // Ensure proper module resolution
    environment: "node",
    globals: true,
  },
});
