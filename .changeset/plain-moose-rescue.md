---
"@ai-sdk-tool/parser": patch
---

fix(parser): enable parallel/multiple tool calls in morphXML system prompt

- Change system prompt from "Use exactly one XML element" to "For each function call, use one XML element"
- Add instruction for sequential multiple tool call output
- Add example showing multiple consecutive XML tool calls
- Fixes BFCL parallel benchmark: 20% → 85% (+325% improvement)
- Fixes BFCL parallel-multiple benchmark: 40% → 100% (+150% improvement)
