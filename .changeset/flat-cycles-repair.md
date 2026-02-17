---
"@ai-sdk-tool/parser": minor
---

Add a new `model` media strategy mode for tool-result handling so tool `content` outputs can be converted into model-recognizable user content parts (`text`/`file`) instead of placeholder-only text.

Update tool-role message conversion and middleware typing to support structured tool-response template outputs, while preserving existing string-based formatter behavior.

Improve prompt shared module naming clarity and align shared test ownership with the renamed modules.
