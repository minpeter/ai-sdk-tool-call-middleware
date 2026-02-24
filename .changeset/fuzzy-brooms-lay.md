---
"@ai-sdk-tool/parser": patch
---

Add `inputExamples` prompt rendering support across all built-in middleware templates, including Hermes, Morph XML, YAML XML, Qwen3Coder, and community presets (UI-TARS and Sijawara variants).

Introduce shared input-example rendering utilities and add regression tests to verify the rendered examples appear in system prompts when tool `inputExamples` are provided.
