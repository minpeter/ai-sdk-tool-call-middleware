import { summarizationBenchmark } from "./summarization";

test("summarization scaffold returns BenchmarkResult shape", async () => {
  const res = await summarizationBenchmark.run({} as any, {});
  expect(res).toHaveProperty("score");
  expect(res).toHaveProperty("success");
  expect(res.logs).toContain("summarization scaffold executed");
});
