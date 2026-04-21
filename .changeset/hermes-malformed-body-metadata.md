---
"@ai-sdk-tool/parser": patch
---

fix: align `onError` parse-fail metadata across all four protocols (Hermes, morph-xml, yaml-xml, qwen3coder). Malformed tool-call bodies now uniformly report `toolName`, `toolCallId`, and `dropReason: "malformed-tool-call-body"`; unresolvable tool names in qwen3coder streaming report `dropReason: "unresolved-tool-name"`; YAML syntax failures inside the YAML helper report `dropReason: "yaml-parse-error"` and `"yaml-non-mapping"`. Complements the existing `unfinished-tool-call` and `malformed-nested-tool-call` reasons so consumers have a single recovery pattern across every protocol
