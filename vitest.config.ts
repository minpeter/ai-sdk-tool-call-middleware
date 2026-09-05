import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8")
);

export default defineConfig({
  define: {
    __PACKAGE_VERSION__: JSON.stringify(version),
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts{,x}"],
    exclude: [
      "**/*.ui.test.ts{,x}",
      "**/*.e2e.test.ts{,x}",
      "**/benchmarks/**",
      "**/node_modules/**",
      "**/.omo/**",
      "**/.omx/**",
    ],
    typecheck: {
      enabled: true,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json"],
      reportsDirectory: "./coverage",
      clean: true,
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts{,x}", "**/*.d.ts"],
    },
  },
});
