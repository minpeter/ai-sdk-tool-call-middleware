import { describe, it, expect, vi } from "vitest";
import { evaluate } from "./evaluate";

describe("evaluate markdown reporter", () => {
  it("calls markdown reporter and outputs markdown", async () => {
    const bm = {
      name: "r1",
      version: "0.1",
      description: "ok",
      run: async () => ({
        score: 7,
        success: false,
        metrics: { foo: "bar" },
        logs: ["log1"],
        error: "fail",
      }),
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await evaluate({
      matrix: { models: [{ name: "m" }] },
      benchmarks: [bm as any],
      reporterType: "markdown",
    });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
