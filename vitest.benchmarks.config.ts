import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["benchmarks/glm-5.2-tool-calling/**/*.test.ts"],
    maxWorkers: 1,
    pool: "forks",
    typecheck: {
      enabled: true,
    },
  },
});
