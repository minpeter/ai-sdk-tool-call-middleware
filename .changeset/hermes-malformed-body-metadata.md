---
"@ai-sdk-tool/parser": patch
---

fix: align Hermes `onError` metadata across streaming and non-streaming parse-fail paths so malformed tool-call bodies now report `toolName`, `toolCallId`, and `dropReason: "malformed-tool-call-body"` consistently with the existing `unfinished-tool-call` and `malformed-nested-tool-call` reasons
