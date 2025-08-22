# LanguageModelV2Benchmark

The `LanguageModelV2Benchmark` interface describes a benchmark that can be executed against a language model.

Fields:

- `name`: string — benchmark identifier
- `version`: string — semantic version of the benchmark
- `description`: string — short description
- `run(model: LanguageModelV2): Promise<BenchmarkResult>` — runs the benchmark against a model and returns `BenchmarkResult`.

See `src/interfaces.ts` for the canonical TypeScript definitions.
