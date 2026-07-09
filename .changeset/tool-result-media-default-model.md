---
"@ai-sdk-tool/parser": patch
---

Default tool-result media handling now passes real AI SDK v4/v7 `file` parts (`mode: "model"`) instead of text placeholders.

- Canonical `{ type: "file", data: SharedV4FileData }` content is forwarded as model file parts; non-canonical content becomes placeholders.
- Protocol formatters (Hermes, Morph XML, Qwen3-Coder, YAML XML) emit hybrid user content (`text` wrapper + adjacent `file` parts) when media is present.
- Opt into the old text-only path with `mediaStrategy: { mode: "placeholder" }` on tool-response formatter factories.
