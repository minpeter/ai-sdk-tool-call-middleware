---
"@ai-sdk-tool/parser": patch
---

Remove CommonJS builds and make the package ESM-only. Consumers must replace
`require("@ai-sdk-tool/parser")` with ESM `import` or dynamic `import()`.

Improve streaming recovery for real-world YAML, Qwen3Coder, and Hermes model
outputs, including adjacent Hermes calls where a model omits only the first
closing `</tool_call>` tag.
