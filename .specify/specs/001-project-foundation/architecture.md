# Architecture Overview

## High-Level View
- **Core parser**: streaming state machine that consumes model deltas and emits structured tool-call events.
- **Protocol adapters**: plug-in modules per dialect (Hermes JSON, Morph XML, YAML/XML hybrid, Qwen/UI-TARS). Each provides tokens, tag semantics, and schema mappers.
- **Middleware factory**: wraps AI SDK `LanguageModelV1` via `wrapLanguageModel`, injecting parser + hooks.
- **Schema coercion layer**: optional Zod-based normalization that ensures tool payloads align with declared schemas before execution.
- **Observability hooks**: event emitter interface for logging + metrics integration.

## Repository Layout
- `src/` — production code grouped by `core/`, protocol folders, and presets (including `examples/hello-tool-middleware.ts`).
- `tests/` — standalone Vitest suites exercising public presets without depending on build artifacts.
- `docs/` — status log + future guides.
- `scripts/` — helper shell scripts for local automation (e.g., `dev-check.sh` mirroring CI).
- `.specify/` — living specs, risks, and ADRs tying the architecture together.

## Module Boundaries
1. `src/core/*`: protocol-agnostic finite state machine, event definitions, error classes.
2. `src/tool-call-middleware.ts`: exports `createToolMiddleware` that glues parser to AI SDK.
3. `src/preconfigured-middleware.ts`: curated presets referencing protocol modules.
4. `src/{rxml,rjson,community}/**`: protocol-specific tokenizers + heuristics.
5. `src/schema-coerce/**`: schema validation + fallback strategies.
6. `src/__tests__/**`: vitest suites with golden fixtures for each protocol.

## Data & API Shape
- **Input**: streaming chunks implementing `ToolCallStreamPart` from `ai` SDK.
- **Output**: `ToolCallEvent` union containing `tool-input-start`, `tool-input-delta`, `tool-input-end`, `tool-call`, `tool-result`.
- **Middleware API**: `createToolMiddleware({ protocol, toolSystemPromptTemplate, onEvent, toolCallOptions })`.
- **Configuration**: protocols declare `ProtocolDescriptor` with regex/key markers, `parseChunk(ctx, chunk)` method, and `finalize(ctx)` flush hook.
- **Schema coercion**: `coerceToolInput(schema, raw, opts)` returning `Result<T, ToolParseError>`.

## Error Handling Strategy
- Dedicated `ToolParseError` hierarchy with metadata (protocol, token index, raw snippet).
- Middleware surfaces errors via `onError` callback while continuing streaming text when safe.
- Fatal protocol mismatches bubble to caller for fallback to plain text.

## Logging & Metrics
- Provide `onEvent(event, ctx)` hook for callers; default implementation logs via `console.debug` with structured object.
- Emit metrics-friendly counters: `parser.events.total`, `parser.errors.byType`, `schema.coercions.retries`.
- Guard under feature flags to avoid perf regressions.

## Testing Strategy
- Unit tests for core state machine + schema coercion.
- Integration tests for each protocol using recorded transcripts in `fixtures/`.
- Snapshot/golden tests for middleware output ordering.
- Fuzz-lite tests for malformed markup to ensure graceful degradation.

## CI & Local Dev
- GitHub Actions workflow `ci.yml` running `pnpm install`, `pnpm build`, `pnpm test`, `pnpm check`.
- Code coverage uploaded via Codecov.
- Local dev uses `pnpm` scripts + `tsx` for running examples; `biome` ensures formatting.
