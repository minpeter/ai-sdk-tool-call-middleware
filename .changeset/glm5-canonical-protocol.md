---
"@ai-sdk-tool/parser": minor
---

Add `glm5ToolMiddleware` for the official GLM-5.2 chat-template tool-call
grammar (`<tool_call>` with `<arg_key>`/`<arg_value>`), including streaming
and parse-generated-text paths.

Harden shared tool-call parsing against pathologically nested payloads and
exact prototype-sensitive JSON-like keys while preserving ordinary keys that
only begin with labels such as `__proto__`, `constructor`, or `prototype`.
