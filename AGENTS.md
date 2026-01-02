# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-02
**Commit:** 7d33b99
**Branch:** feat/orchestrator-yaml-xml-protocol

## OVERVIEW

Middleware enabling tool calling for AI SDK v5 models lacking native `tools` support. pnpm monorepo with Turborepo orchestration.

## STRUCTURE

```
ai-sdk-tool-call-middleware/
├── packages/
│   ├── parser/      # Core tool-call parsing middleware (main package)
│   ├── eval/        # Benchmarking (BFCL, JSON generation)
│   ├── rxml/        # XML parser/builder for AI-generated XML
│   ├── proxy/       # OpenAI-compatible proxy server
│   ├── middleware/  # Shared middleware utilities (disk cache)
│   └── opencode-plugin/  # OpenCode integration
├── examples/
│   ├── parser-core/ # Parser usage examples
│   ├── eval-core/   # Benchmark examples
│   ├── rxml-core/   # RXML streaming examples
│   └── proxy-core/  # Proxy server examples
├── docs/            # Documentation site content
├── scripts/         # CI benchmark scripts
└── tools/tsconfig/  # Shared tsconfig presets
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add protocol | `packages/parser/src/core/protocols/` | Implement `ToolCallProtocol` interface |
| Add middleware | `packages/parser/src/v6/` | v6 = AI SDK v5 (LanguageModelV3) |
| Add benchmark | `packages/eval/src/benchmarks/` | Implement `LanguageModelV3Benchmark` |
| XML parsing | `packages/rxml/src/core/` | parser.ts, stream.ts, tokenizer.ts |
| Proxy endpoints | `packages/proxy/src/server.ts` | Fastify routes |
| Heuristic repair | `packages/parser/src/core/heuristics/` | XML tag balancing, schema repair |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `createToolMiddleware` | Factory | parser/v6/tool-call-middleware.ts | Main middleware factory |
| `ToolCallProtocol` | Interface | parser/core/protocols/tool-call-protocol.ts | Protocol contract |
| `jsonMixProtocol` | Protocol | parser/core/protocols/json-mix-protocol.ts | JSON in markdown fences |
| `morphXmlProtocol` | Protocol | parser/core/protocols/morph-xml-protocol.ts | XML-based tool calls |
| `yamlXmlProtocol` | Protocol | parser/core/protocols/yaml-xml-protocol.ts | YAML args in XML tags |
| `evaluate` | Function | eval/src/evaluate.ts | Run benchmarks |
| `OpenAIProxyServer` | Class | proxy/src/server.ts | Proxy server |
| `parse` | Function | rxml/src/core/parser.ts | XML to object |

## CONVENTIONS

### Protocol Architecture
- Each protocol implements 5 methods: `formatTools`, `formatToolCall`, `formatToolResponse`, `parseGeneratedText`, `createStreamParser`
- Protocols can be factory functions `() => ToolCallProtocol` for per-request state

### Version Directories
- `v5/` = AI SDK v4 support (LanguageModelV1)
- `v6/` = AI SDK v5 support (LanguageModelV3) - **default export**

### Testing
- Vitest with colocated tests (`*.test.ts` next to source)
- Protocol tests in `__tests__/protocols/`
- E2E tests in `__tests__/e2e/`

### Biome/Ultracite
- Extends `ultracite/biome/core`
- `noConsole: off` - console allowed (CLI tools)
- `noMagicNumbers: off` - numbers allowed

## ANTI-PATTERNS (THIS PROJECT)

- **NEVER** suppress types with `as any`, `@ts-ignore`, `@ts-expect-error`
- **NEVER** use barrel files except package index.ts (biome-ignore comment required)
- **NEVER** commit `.env` files - use `.env.example`
- **NEVER** use `var` - use `const`/`let`

## UNIQUE STYLES

- Middleware wraps both streaming (`wrapStream`) and batch (`wrapGenerate`) modes
- `providerOptions.toolCallMiddleware` for internal state propagation
- Debug via `DEBUG_PARSER_MW=stream|parse` env var
- Heuristic pipeline for XML repair before parsing

## COMMANDS

```bash
# Development
pnpm install          # Install all deps
pnpm build            # Build all packages (turbo)
pnpm dev              # Watch mode
pnpm test             # Run all tests
pnpm typecheck        # Type-check all

# Single package
cd packages/parser && pnpm test:watch

# Formatting (Biome/Ultracite)
pnpm fmt:biome        # Auto-fix
pnpm check:biome      # Check only

# Release
pnpm changeset        # Create changeset
pnpm ci:release       # Build + publish

# Benchmarks
pnpm ci:benchmark     # Run regression benchmarks
pnpm ci:compare       # Compare benchmark results
```

## NOTES

- Requires Node >= 18, pnpm 9.x
- AI SDK v5 required. For v4, pin `@ai-sdk-tool/parser@1.0.0`
- Examples require API keys in env (OPENROUTER_API_KEY, etc.)
- Pre-commit hook runs Biome check via Husky
