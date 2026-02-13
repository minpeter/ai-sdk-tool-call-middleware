---
"@ai-sdk-tool/parser": minor
---

Change XML/YAML streaming `tool-input-delta` semantics to emit parsed JSON argument prefixes instead of raw XML/YAML fragments.

- Add shared streamed tool-input delta helpers for monotonic prefix emission and finish-time remainder reconciliation.
- Keep JSON protocol behavior unchanged.
- Preserve ID reconciliation across `tool-input-start`, `tool-input-end`, and final `tool-call`.
- Suppress raw XML/YAML tool-markup fallback in streaming parse failures by default to avoid leaking protocol text to end users (opt-in via `emitRawToolCallTextOnError: true`).
- Add tests and fixture updates for value-split/key-split streaming chunks, finish reconciliation, malformed paths, and fallback policy.

**BREAKING CHANGE**: `emitRawToolCallTextOnError` now defaults to `false`. Previously, malformed XML/YAML tool calls would emit raw markup as `text-delta` fallback. Now this is opt-in. If you relied on this behavior, set `emitRawToolCallTextOnError: true` in your parser options.
