---
"@ai-sdk-tool/parser": patch
---

Handle tool calls with undefined/null input and clean up type casting. formatToolCall functions now handle null/undefined input gracefully. Replace manual type guards with discriminated union narrowing using switch statements. Extract extractSchemaProperties helper in xml-defaults.ts to reduce code duplication.
