import { LanguageModel, generateObject } from 'ai';
import { z } from 'zod';
import {
  LanguageModelV2Benchmark,
  BenchmarkResult,
} from '../interfaces.js';

// NOTE: This benchmark is temporarily disabled due to a persistent
// TypeScript error (TS2589: Type instantiation is excessively deep)
// when using z.object with generateObject within this project structure.
// The core logic is sound, but it prevents the project from compiling.
// The BFCL benchmarks, which are the core of this project, are unaffected.

export const jsonGenerationBenchmark: LanguageModelV2Benchmark = {
  name: 'json-generation',
  version: '1.2.0',
  description: 'Evaluates the model ability to generate schema-compliant JSON. (Temporarily Disabled)',

  async run(model: LanguageModel): Promise<BenchmarkResult> {
    return {
        score: 0,
        success: false,
        metrics: {
            status: "disabled",
        },
        logs: ["This benchmark is temporarily disabled due to a TypeScript compilation error."],
    };
  },
};
