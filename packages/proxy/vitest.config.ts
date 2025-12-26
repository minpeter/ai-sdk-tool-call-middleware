import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "src/test/**"],
    hookTimeout: 30_000,
    testTimeout: 60_000, // 60 seconds for individual tests
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        "src/test/",
        "**/*.d.ts",
        "**/*.config.*",
        "**/test-runner.ts",
      ],
      thresholds: {
        global: {
          branches: 70,
          functions: 70,
          lines: 70,
          statements: 70,
        },
      },
    },
    setupFiles: [],
    sequence: {
      shuffle: false,
      concurrent: true,
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
