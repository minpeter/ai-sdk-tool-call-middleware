import { describe, it, expect, vi } from "vitest";
import { evaluate } from "./evaluate";

describe("evaluate reporters", () => {
  it("calls console reporter when reporterType=console", async () => {
    const bm = {
      name: "r1",
      version: "0.1",
      description: "ok",
      run: async () => ({ score: 3, success: true, metrics: {}, logs: [] }),
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const modelStub = {} as any;
    await evaluate({
      matrix: { models: [modelStub] },
      benchmarks: [bm as any],
      reporterType: "console",
    });

    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
