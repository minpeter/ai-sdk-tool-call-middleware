---
"@ai-sdk-tool/parser": patch
---

Default tool-result media handling now passes real AI SDK v4/v7 `file` parts (`mode: "model"`) instead of text placeholders.

- Canonical `{ type: "file", data: SharedV4FileData }` content is forwarded as model file parts; non-canonical content becomes placeholders.
- Hermes, Morph XML, and Qwen3-Coder formatters emit hybrid user content (`text` wrapper + adjacent `file` parts) when media is present. YAML XML tool responses reuse the Morph XML response formatter (same hybrid behavior by default).
- Opt into the old text-only path with `mediaStrategy: { mode: "placeholder" }` via `createHermesToolResponseFormatter` / `createMorphXmlToolResponseFormatter` / `createQwen3CoderXmlToolResponseFormatter` (YAML XML apps should use the Morph factory for response formatting options).
- URL-backed file parts only forward `http:` / `https:` URLs; other schemes degrade to placeholders. String URLs are intentionally reparsed to `URL` (JSON-deserialized payloads).
- Remove the `raw` media strategy mode (use `model`, `placeholder`, or capability-gated `auto`).
