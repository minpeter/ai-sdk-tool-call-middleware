import { bfclBenchmark } from "./bfcl";

test("bfcl scaffold returns BenchmarkResult shape", async () => {
  const res = await bfclBenchmark.run({} as any, {});
  expect(res).toHaveProperty("score");
  expect(res).toHaveProperty("success");
  expect(res.logs).toContain("bfcl scaffold run executed");
});
