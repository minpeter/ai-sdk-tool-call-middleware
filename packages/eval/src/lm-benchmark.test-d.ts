import type { LanguageModelV2Benchmark } from "./interfaces";

// Verify the interface shape compiles
const bm: LanguageModelV2Benchmark = {
  name: "test-bm",
  version: "0.0.1",
  description: "sanity",
  run: async (_m: unknown) => ({
    score: 0,
    success: true,
    metrics: {},
    logs: [],
  }),
};

void bm;
