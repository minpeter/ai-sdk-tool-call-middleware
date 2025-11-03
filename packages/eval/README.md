# AI SDK - evaluation tool

[![npm](https://img.shields.io/npm/v/@ai-sdk-tool/eval)](https://www.npmjs.com/package/@ai-sdk-tool/eval)
[![npm](https://img.shields.io/npm/dt/@ai-sdk-tool/eval)](https://www.npmjs.com/package/@ai-sdk-tool/eval)

This package provides a standardized, extensible, and reproducible way to benchmark and evaluate the performance of Language Models (`LanguageModel` instances) within the Vercel AI SDK ecosystem.

It allows developers to:

- Compare different models (e.g., Gemma, Llama, GPT) under the same conditions.
- Quantify the impact of model updates or configuration changes.
- Create custom benchmarks tailored to specific use cases (e.g., 'Korean proficiency', 'code generation').
- Automate the evaluation process across a matrix of models and configurations.

## Core Concepts

- **Benchmark (`LanguageModelV3Benchmark`)**: A standardized interface for creating an evaluation task. It has a `run` method that takes a `LanguageModel` and returns a `BenchmarkResult`.
- **`evaluate` function**: The core function that runs a set of benchmarks against one or more models and provides a report on the results.
- **Reporter**: Formats the evaluation results into different outputs, such as a human-readable console report or a machine-readable JSON object.

## Installation

```bash
pnpm add @ai-sdk-tool/eval
```

## Quick Start

Here's how to evaluate two different models against the built-in Berkeley Function-Calling Leaderboard (BFCL) benchmark for simple function calls.

```typescript
import { evaluate, bfclSimpleBenchmark } from "@ai-sdk-tool/eval";
import { openrouter } from "ai/providers/openrouter";

// 1. Define the models you want to evaluate
const gemma9b = openrouter("google/gemma-3-9b-it");
const gemma27b = openrouter("google/gemma-3-27b-it");

// 2. Run the evaluation
async function runMyEvaluation() {
  console.log("Starting model evaluation...");

  const results = await evaluate({
    models: [gemma9b, gemma27b],
    benchmarks: [bfclSimpleBenchmark], // Use a built-in benchmark
    reporter: "console", // 'console' or 'json'
  });

  console.log("Evaluation complete!");
  // The console reporter will have already printed a detailed report.
}

runMyEvaluation();
```

Run the example from this repo:

```bash
cd examples/eval-core && pnpm dlx tsx src/bfcl-simple.ts
```

## Built-in Benchmarks

This package includes several pre-built benchmarks.

- `bfclSimpleBenchmark`: Evaluates simple, single function calls.
- `bfclParallelBenchmark`: Evaluates parallel (multi-tool) function calls.
- `bfclMultipleBenchmark`: Evaluates multiple calls to the same function.
- `bfclParallelMultipleBenchmark`: A combination of parallel and multiple function calls.
- `jsonGenerationBenchmark`: Evaluates the model's ability to generate schema-compliant JSON.

To try a JSON generation run locally:

```bash
cd examples/eval-core && pnpm dlx tsx src/json-generation.ts
```

## Creating a Custom Benchmark

You can easily create your own benchmark by implementing the `LanguageModelV3Benchmark` interface. This is useful for testing model performance on tasks specific to your application.

**Example: A custom benchmark to test politeness.**

```typescript
import {
  LanguageModelV3Benchmark,
  BenchmarkResult,
  EvaluateOptions,
} from "@ai-sdk-tool/eval";
import { LanguageModel, generateText } from "ai";

// Define the benchmark object
export const politenessBenchmark: LanguageModelV3Benchmark = {
  name: "politeness-check",
  version: "1.0.0",
  description: "Checks if the model's response is polite.",

  async run(model: LanguageModel): Promise<BenchmarkResult> {
    const { text } = await generateText({
      model,
      prompt:
        "A customer is angry because their order is late. Write a response.",
    });

    const isPolite = !text.toLowerCase().includes("sorry, but");
    const score = isPolite ? 1 : 0;

    return {
      score,
      success: isPolite,
      metrics: {
        length: text.length,
      },
      logs: [`Response: "${text}"`],
    };
  },
};

// You can then use it in the evaluate function:
// await evaluate({
//   models: myModel,
//   benchmarks: [politenessBenchmark],
// });
```

## License

Licensed under Apache License 2.0. See the repository `LICENSE`. Include the `NOTICE` file in distributions.
