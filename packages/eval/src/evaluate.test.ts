import { describe, it, expect, vi } from "vitest";
import { evaluate } from "./evaluate";
import type { LanguageModelV2Benchmark } from "./interfaces";

const sampleResult = { score: 0.5, success: true, metrics: {}, logs: [] };

const bm: LanguageModelV2Benchmark = {
  name: "e2e",
  version: "0.1",
  description: "e2e",
  run: async () => sampleResult,
};

describe("evaluate", () => {
  it("runs benchmarks and calls reporter", async () => {
    const reporter = vi.fn();
    const res = await evaluate({
      matrix: { models: [{ name: "m1" }] },
      benchmarks: [bm],
      reporter,
    });
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual(sampleResult);
    expect(reporter).toHaveBeenCalledWith(sampleResult);
  });
});
