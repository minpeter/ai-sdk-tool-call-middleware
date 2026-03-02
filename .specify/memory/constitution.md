# AI SDK Tool Call Middleware Constitution

## Guiding Principles
- **Simplicity first**: prefer explicit data structures and linear control flow over clever abstractions; middleware glue must stay readable by default AI SDK users.
- **Testability**: every parsing strategy must expose pure functions for schema validation and have deterministic fixtures in `tests/` so regressions show up quickly.
- **Security posture**: never execute tool payloads; sanitize/limit any reflection of model output; default to zero trust on upstream data.
- **Observability + diagnostics**: provide structured logs/events (level + metadata) for each tool-call transition so host apps can trace failures without deep debugging.
- **Performance envelope**: parsers must stream in O(n) time with bounded memory; no buffering of full transcripts when incremental parsing is possible.
- **Extensibility**: new protocol implementations should plug in via documented interfaces without copy/paste; favor dependency injection for transport/env specific pieces.

## Collaboration + Style
- Use TypeScript strict mode, Biome formatting, and vitest for unit tests.
- Public APIs need TSDoc blocks describing contracts and constraints.
- Keep files under ~300 LOC; break out helpers when needed.
- Align naming with AI SDK concepts (`middleware`, `protocol`, `toolCall`).

## Definition of Done
1. Specification + ADR updated when architectural behavior changes.
2. Types + runtime guards enforce the same contract; no `any` in shipped code.
3. Automated tests and lint pass locally and in CI.
4. Documentation (README/docs/STATUS) reflects latest capabilities and known limitations.
5. Observability hooks (logging/metrics events) are either implemented or explicitly stubbed with TODOs and tracked tasks.
6. Security review checklist completed for any new input surface.
