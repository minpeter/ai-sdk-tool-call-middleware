---
"@ai-sdk-tool/parser": major
---

Stream stable, monotonic JSON argument deltas for tool calls across protocols.

- `jsonProtocol`: `tool-input-delta` streams canonical JSON argument text.
- `xmlProtocol` and `yamlProtocol`: `tool-input-delta` streams parsed JSON argument prefixes (not raw XML/YAML fragments).
- Preserve ID reconciliation across `tool-input-start`, `tool-input-end`, and final `tool-call`.
- Tool call ids are now generated in an OpenAI-like `call_` format.
- Suppress raw protocol-markup fallback in streaming parse failures by default to avoid leaking internal markup to end users (opt-in via `emitRawToolCallTextOnError: true`).
- Add tests and fixture updates for value-split/key-split streaming chunks, finish reconciliation, malformed paths, and fallback policy.

**BREAKING CHANGE**: `emitRawToolCallTextOnError` now defaults to `false`. Previously, malformed streaming tool calls could emit raw protocol markup as `text-delta` fallback. Now this is opt-in. If you relied on this behavior, set `emitRawToolCallTextOnError: true` in your parser options.
