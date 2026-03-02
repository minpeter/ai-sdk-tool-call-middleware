# Project Foundation Specification

## Problem Statement
Models like OpenAI-compatible LLMs often emit tool-call markup even when the hosting SDK lacks built-in `tools` support. We need a reusable TypeScript middleware package (`@ai-sdk-tool/parser`) that can:
1. Parse multiple tool-call dialects (JSON, XML, YAML hybrids) in streaming fashion.
2. Normalize parsed payloads into AI SDK `ToolExecutionRequest` objects.
3. Provide preconfigured middleware plus composable protocol primitives so integrators can adapt quickly.

## In Scope
- Middleware factory + protocol implementations for Hermes, Morph XML, YAML/XML, Qwen/UI-TARS.
- Schema coercion helpers (Zod) and error-handling hooks.
- Streaming parsers that surface deltas + final tool calls.
- Minimal documentation (README, docs/STATUS, new architecture/spec files).
- CI workflow skeleton (lint, typecheck, test).
- Examples directory linkage (reuse existing examples, ensure structure referenced).

## Out of Scope
- Hosting UI or CLI beyond sample usage.
- Full-blown monitoring backend; we emit hooks only.
- Network transports or provider-specific authentication.
- Supporting non-TypeScript runtimes.

## User Stories
1. **AI SDK integrator** wants to drop in middleware and see tool calls parsed reliably, with minimal config changes.
2. **Protocol author** wants to implement a new tagging dialect by conforming to shared interfaces without editing core modules.
3. **Operator** wants to observe parsing failures via structured logs/metrics to debug misbehaving models quickly.
4. **Maintainer** needs tests + CI to guard against regressions when bumping AI SDK versions.

## Non-Functional Requirements
- **Performance**: streaming parsing must process tokens in O(n) time with <5ms added latency for 1KB payload bursts.
- **Reliability**: middleware must gracefully recover from malformed markup, emit errors, and continue streaming text when possible.
- **Security**: never evaluate tool payloads; validate input schemas and cap nested depth to avoid DoS via recursion.
- **Compatibility**: support Node 18+ and align with pnpm 9, Typescript 5.9 strict mode.
- **Observability**: expose hooks for logging + metrics on parser state transitions, error counts, and coercion outcomes.

## Acceptance Criteria
1. Constitution, specification, architecture, tasks, and ADR files exist and describe current design.
2. Minimal runnable skeleton builds with `pnpm build`, `pnpm test`, and `pnpm check`.
3. `docs/STATUS.md` logs progress each pass.
4. Streaming parser interface documented with at least one working example/test.
5. CI workflow ensures lint/type/test run on push + PR.

## Open Questions
- Should we break package into monorepo packages (parser, community protocols) or keep single package with exports? (Current plan: single package, revisit once complexity grows.)
- Which logging facade should we adopt (pino, console, custom events)? (Current assumption: dependency-free structured event emitter.)
- Do we need stable tool-call IDs across retries? (Assume yes; ID reconciliation stays in core.)
