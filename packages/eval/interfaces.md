# Eval Interfaces

This module exports core TypeScript interfaces and types used by the evaluation system.

- `LanguageModelV2Benchmark` — interface describing a benchmark for a language model.
- `BenchmarkResult` — result returned by benchmark runs: `{ score, success, metrics, logs, error? }`.
- `EvaluateOptions` — configuration for running evaluation matrices and benchmarks.

Usage: import types from `@ai-sdk-tool/eval/src/interfaces` for compile-time checks.
