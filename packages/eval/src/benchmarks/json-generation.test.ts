import { jsonGenerationBenchmark } from "./json-generation";

test("json-generation scaffold returns BenchmarkResult shape", async () => {
  const res = await jsonGenerationBenchmark.run({} as any, {});
  expect(res).toHaveProperty("score");
  expect(res).toHaveProperty("success");
  expect(res.metrics).toHaveProperty("validJson");
  expect(res.logs).toContain("json-generation scaffold executed");
});
