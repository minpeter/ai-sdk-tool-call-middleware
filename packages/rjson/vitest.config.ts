import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts{,x}"],
    exclude: [
      "**/*.ui.test.ts{,x}",
      "**/*.e2e.test.ts{,x}",
      "**/node_modules/**",
    ],
    typecheck: {
      enabled: true,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      clean: true,
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts{,x}", "**/*.d.ts"],
    },
  },
});
