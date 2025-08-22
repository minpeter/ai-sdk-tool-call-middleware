import { describe, it, expect } from "vitest";
import { evaluate } from "./evaluate";
import fs from "fs";
import os from "os";
import path from "path";

describe("evaluate persistence", () => {
  it("writes aggregated result to disk when persistPath provided", async () => {
    const bm = {
      name: "p1",
      version: "0.1",
      description: "ok",
      run: async () => ({
        score: 5,
        success: true,
        metrics: { a: 1 },
        logs: [],
      }),
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));
    const out = path.join(tmpDir, "agg.json");

    const res = await evaluate({
      matrix: { models: [{ name: "m" }] },
      benchmarks: [bm as any],
      persistPath: out,
    });

    expect(res.length).toBe(1);
    const content = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(content.total).toBe(1);
    // cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
