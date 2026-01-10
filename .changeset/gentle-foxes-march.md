---
"@ai-sdk-tool/parser": patch
---

Handle tool calls with undefined/null input and simplify type checking. formatToolCall functions now handle null/undefined input gracefully, and processAssistantContent uses switch statement for cleaner discriminated union narrowing instead of manual type guards.
