# Evaluation

Use `@ai-sdk-tool/eval` to benchmark AI SDK-compatible models.

## Quick Start

```ts
import { evaluate, bfclSimpleBenchmark } from "@ai-sdk-tool/eval";
import { openrouter } from "ai/providers/openrouter";

const modelA = openrouter("google/gemma-3-9b-it");
const modelB = openrouter("google/gemma-3-27b-it");

// You can pass an array of models …
await evaluate({
  models: [modelA, modelB],
  benchmarks: [bfclSimpleBenchmark],
  reporter: "console",
});

// …or a keyed map to label results per model
await evaluate({
  models: { small: modelA, large: modelB },
  benchmarks: [bfclSimpleBenchmark],
  reporter: "json",
});
```

## Built-in Benchmarks

- `bfclSimpleBenchmark`, `bfclParallelBenchmark`, `bfclMultipleBenchmark`, `bfclParallelMultipleBenchmark`
- `jsonGenerationBenchmark`, `jsonGenerationSchemaOnlyBenchmark`

See runnable examples in `examples/eval-core/src/*`.

## Reporters and Returns

- `reporter`: `"console" | "json" | "console.debug"` (default: `"console"`)
- Returns: `EvaluationResult[]` with per model/benchmark `score`, `success`, and `metrics`.

## [dev] Create a Custom Benchmark

Implement `LanguageModelV2Benchmark` and pass it to `evaluate`.

```ts
import { generateText } from "ai";
import type {
  LanguageModelV2Benchmark,
  BenchmarkResult,
} from "@ai-sdk-tool/eval";

export const myBenchmark: LanguageModelV2Benchmark = {
  name: "my-benchmark",
  version: "1.0.0",
  description: "Minimal example",
  async run(model): Promise<BenchmarkResult> {
    const { text } = await generateText({
      model,
      messages: [{ role: "user", content: "Say 'ok'" }],
    });
    const pass = text.trim().toLowerCase().includes("ok");
    return {
      score: pass ? 1 : 0,
      success: pass,
      metrics: { accuracy: pass ? 1 : 0 },
    };
  },
};
```

## [dev] BFCL Runtime Controls

- `BFCL_LIMIT`: limit number of BFCL test cases (e.g., `BFCL_LIMIT=50`).
- `BFCL_CONCURRENCY`: parallel case runner (default `4`).
