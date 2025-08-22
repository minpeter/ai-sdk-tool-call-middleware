import { getAllBenchmarks, getBenchmarkByName } from "./registry";

test("registry returns built-ins", () => {
  const all = getAllBenchmarks();
  expect(Array.isArray(all)).toBe(true);
  expect(all.length).toBeGreaterThanOrEqual(3);
  const j = getBenchmarkByName("json-generation");
  expect(j).toBeDefined();
  expect(j?.name).toBe("json-generation");
});
