import { describe, expect, it } from "vitest";
import { benchmarkStagePilotStrategies } from "../src/stagepilot/benchmark";

describe("stagepilot benchmark harness", () => {
  it("shows middleware and ralph-loop gains over baseline", async () => {
    const report = await benchmarkStagePilotStrategies({
      caseCount: 21,
      maxLoopAttempts: 2,
      seed: 42,
    });

    const baseline = report.strategies.find(
      (item) => item.strategy === "baseline"
    );
    const middleware = report.strategies.find(
      (item) => item.strategy === "middleware"
    );
    const loop = report.strategies.find(
      (item) => item.strategy === "middleware+ralph-loop"
    );

    expect(baseline).toBeDefined();
    expect(middleware).toBeDefined();
    expect(loop).toBeDefined();

    expect(middleware?.successRate ?? 0).toBeGreaterThan(
      baseline?.successRate ?? 0
    );
    expect(loop?.successRate ?? 0).toBeGreaterThanOrEqual(
      middleware?.successRate ?? 0
    );
    expect(loop?.avgAttemptsUsed ?? 0).toBeGreaterThan(1);
  });
});
