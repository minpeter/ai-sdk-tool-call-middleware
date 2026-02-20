---
"@ai-sdk-tool/parser": patch
---

Fix morph XML streaming end-tag matching by escaping tool names before building the closing-tag regex.
This preserves correct parsing for tool names with regex metacharacters (for example `weather.v2`) and prevents premature or missed tool-call termination in stream output.
