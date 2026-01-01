import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const version = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8")
).version;

export default defineConfig({
  define: {
    __PACKAGE_VERSION__: JSON.stringify(version),
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts{,x}"],
    exclude: ["**/node_modules/**"],
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
