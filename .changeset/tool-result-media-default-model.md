---
"@ai-sdk-tool/parser": patch
---

Default tool-result media handling now passes real AI SDK v4/v7 `file` parts (`mode: "model"`) instead of text placeholders.

- Convert deprecated `image-*` / `file-*` content aliases into canonical `{ type: "file", data: SharedV4FileData }` shapes (`data` / `url` / `reference`).
- Protocol formatters (Hermes, Morph XML, Qwen3-Coder, YAML XML) emit hybrid user content (`text` wrapper + adjacent `file` parts) when tool results include media.
- Opt into the old text-only path with `mediaStrategy: { mode: "placeholder" }` on tool-response formatter factories.
