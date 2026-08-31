import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflowSchema = z.object({
  jobs: z.object({
    "benchmark-tests": z.object({
      steps: z.array(
        z.object({
          run: z.string().optional(),
          uses: z.string().optional(),
          with: z.record(z.string(), z.unknown()).optional(),
        })
      ),
    }),
  }),
});

describe("Python benchmark workflow contract", () => {
  it("runs complete locked Python discovery alongside Node 22 benchmarks", () => {
    // Given: the benchmark job consumed by CI
    const workflow = workflowSchema.parse(
      parse(readFileSync(".github/workflows/code-quality.yml", "utf8"))
    );
    const { steps } = workflow.jobs["benchmark-tests"];

    // When: runtime setup and benchmark test commands are selected
    const node = steps.find((step) => step.uses === "actions/setup-node@v7");
    const python = steps.find(
      (step) => step.uses === "actions/setup-python@v6"
    );
    const uv = steps.find((step) => step.uses === "astral-sh/setup-uv@v7");
    const commands = steps.flatMap((step) => (step.run ? [step.run] : []));

    // Then: both benchmark suites run with their locked runtime contracts
    expect(node?.with?.["node-version"]).toBe(22);
    expect(python?.with?.["python-version"]).toBe("3.12");
    expect(uv?.with?.version).toBe("0.11.28");
    expect(commands).toContain("uv sync --locked --only-group benchmark-test");
    expect(commands).toContain("uv run --locked --no-sync pytest");
    expect(commands).toContain("pnpm test:benchmarks");
  });
});
