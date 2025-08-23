import { it, describe, expect } from "vitest";
import { evaluate } from "./evaluate";

describe("evaluate aggregation", () => {
  it("aggregates results and calls aggregateReporter", async () => {
    const bm1 = {
      name: "a1",
      version: "0.1",
      description: "ok",
      run: async () => ({
        score: 2,
        success: true,
        metrics: { latency: 10 },
        logs: [],
      }),
    };
    const bm2 = {
      name: "a2",
      version: "0.1",
      description: "fail",
      run: async () => ({
        score: 0,
        success: false,
        metrics: { latency: 50 },
        logs: [],
        error: "boom",
      }),
    };

    let called = false;
    let aggArg: any = null;

    const modelStub = {} as any;
    const res = await evaluate({
      matrix: { models: [modelStub] },
      benchmarks: [bm1 as any, bm2 as any],
      aggregateReporter: agg => {
        called = true;
        aggArg = agg;
      },
    });

    expect(res.length).toBe(2);
    expect(called).toBe(true);
    expect(aggArg.total).toBe(2);
    expect(aggArg.successRate).toBeCloseTo(0.5);
    expect(aggArg.failures.length).toBe(1);
    expect(aggArg.metrics).toHaveProperty("latency");
  });
});
