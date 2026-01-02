# packages/eval

Benchmarking and evaluation for AI SDK language models.

## STRUCTURE

```
src/
├── benchmarks/
│   ├── bfcl.ts              # BFCL benchmark variants
│   ├── bfcl/ast-checker.ts  # AST-based result validation
│   ├── json-generation.ts   # JSON schema compliance
│   └── complex-func-bench.ts # Complex function calling
├── reporters/
│   ├── console.ts           # Human-readable output
│   ├── console.summary.ts   # Summary view
│   ├── console.debug.ts     # Verbose debugging
│   └── json.ts              # Machine-readable JSON
├── evaluate.ts              # Main evaluate() function
└── interfaces.ts            # Core types
data/
├── BFCL_v4_*.jsonl          # BFCL test cases
└── json_generation_*.jsonl  # JSON generation test cases
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Run evaluation | `evaluate.ts` - `evaluate()` function |
| Add benchmark | `benchmarks/` - implement `LanguageModelV3Benchmark` |
| Add reporter | `reporters/` - add to index exports |
| Modify scoring | Individual benchmark `run()` method |

## BENCHMARK INTERFACE

```typescript
interface LanguageModelV3Benchmark {
  name: string;
  version: string;
  description: string;
  run(model: LanguageModel, config?: Record<string, unknown>): Promise<BenchmarkResult>;
}

interface BenchmarkResult {
  score: number;      // 0-1 normalized
  success: boolean;
  metrics: Record<string, unknown>;
  logs?: string[];
  error?: Error;
}
```

## BUILT-IN BENCHMARKS

| Export | Description |
|--------|-------------|
| `bfclSimpleBenchmark` | Single function calls |
| `bfclParallelBenchmark` | Multi-tool parallel calls |
| `bfclMultipleBenchmark` | Multiple same-function calls |
| `bfclParallelMultipleBenchmark` | Combined parallel + multiple |
| `jsonGenerationBenchmark` | Schema-compliant JSON |
| `jsonGenerationSchemaOnlyBenchmark` | Schema compliance only |
| `complexFuncBenchBenchmark` | Complex function scenarios |

## USAGE

```typescript
import { evaluate, bfclSimpleBenchmark } from "@ai-sdk-tool/eval";

const results = await evaluate({
  models: [model1, model2],          // or { alias: model }
  benchmarks: [bfclSimpleBenchmark],
  reporter: "console",               // "console" | "json"
  cache: { enabled: true },          // Disk caching
  temperature: 0,
  maxTokens: 4096,
});
```

## CACHING

Evaluation uses `@ai-sdk-tool/middleware` disk cache:
- Cache dir: `.ai-cache/` (configurable)
- Keyed by: model + params hash
- Enable: `cache: { enabled: true }`

## REPORTERS

| Reporter | Output |
|----------|--------|
| `console` | Formatted table with scores |
| `console.summary` | Compact summary |
| `console.debug` | Verbose with all metrics |
| `json` | Machine-readable JSON |

## CONVENTIONS

- BFCL data from Berkeley Function Calling Leaderboard
- Scores normalized 0-1 (1 = perfect)
- `ModelConfig` allows middleware per-model

## TESTS

```bash
pnpm test              # Run tests
cd examples/eval-core && pnpm dlx tsx src/bfcl-simple.ts  # Example run
```
