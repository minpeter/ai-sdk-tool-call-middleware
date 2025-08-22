import { describe, it, expect } from "vitest";
import type { BenchmarkResult, LanguageModelV2Benchmark } from "./interfaces";

// runtime smoke test: ensure a simple benchmark can be executed
const sampleResult: BenchmarkResult = {
  score: 1,
  success: true,
  metrics: { ok: true },
  logs: ["run"],
};

const benchmark: LanguageModelV2Benchmark = {
  name: "smoke",
  version: "0.1",
  description: "smoke test",
  run: async (_model: any) => sampleResult,
};

describe("interfaces smoke", () => {
  it("runs benchmark", async () => {
    const res = await benchmark.run(undefined as any);
    expect(res).toEqual(sampleResult);
  });
});
