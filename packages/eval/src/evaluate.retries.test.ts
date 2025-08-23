import { describe, it, expect } from "vitest";
import { evaluate } from "./evaluate";

describe("evaluate retries/backoff", () => {
  it("retries and succeeds", async () => {
    let attempts = 0;
    const bm = {
      name: "r1",
      version: "0.1",
      description: "flaky",
      run: async () => {
        attempts++;
        if (attempts < 3) throw new Error("fail");
        return { score: 1, success: true, metrics: {}, logs: [] };
      },
    };

    const modelStub = {} as any;
    const res = await evaluate({
      matrix: { models: [modelStub] },
      benchmarks: [bm as any],
      retries: 3,
    });
    expect(res[0].success).toBe(true);
    expect(attempts).toBe(3);
  });

  it("returns failure result when retries exhausted and not failFast", async () => {
    const bm = {
      name: "r2",
      version: "0.1",
      description: "always fail",
      run: async () => {
        throw new Error("always");
      },
    };

    const modelStub2 = {} as any;
    const res = await evaluate({
      matrix: { models: [modelStub2] },
      benchmarks: [bm as any],
      retries: 1,
      failFast: false,
    });
    expect(res[0].success).toBe(false);
    expect(res[0].error).toContain("Error");
  });

  it("throws when retries exhausted and failFast true", async () => {
    const bm = {
      name: "r3",
      version: "0.1",
      description: "always fail",
      run: async () => {
        throw new Error("always");
      },
    };

    const modelStub3 = {} as any;
    await expect(
      evaluate({
        matrix: { models: [modelStub3] },
        benchmarks: [bm as any],
        retries: 1,
        failFast: true,
      })
    ).rejects.toThrow();
  });
});
