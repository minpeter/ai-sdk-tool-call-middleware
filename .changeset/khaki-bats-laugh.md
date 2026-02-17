---
"@ai-sdk-tool/parser": minor
---

Add Qwen3-Coder dedicated middleware and prompt/protocol support, including:

- Qwen3-Coder specific system-prompt rendering aligned to the Qwen tool format.
- Qwen3-Coder tool-response formatting and assistant tool-call text conversion flow.
- Prompt-layer refactor that separates shared prompt utilities from protocol-specific prompt modules for better maintainability.
