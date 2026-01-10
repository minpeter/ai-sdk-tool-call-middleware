---
"@ai-sdk-tool/parser": patch
---

Fix tool call signature disappearing when input is undefined or null. The type guard now correctly identifies tool calls with missing input, and formatToolCall functions handle null/undefined input gracefully.
