---
"@ai-sdk-tool/parser": patch
---

fix: align `onError` parse-fail metadata across all four protocols (Hermes, morph-xml, yaml-xml, qwen3coder). Malformed tool-call bodies now uniformly report `{ toolCall, toolName, toolCallId, dropReason: "malformed-tool-call-body" }`; unresolvable tool names in qwen3coder streaming report `dropReason: "unresolved-tool-name"`. Underlying YAML helper failures are no longer surfaced as separate `onError` calls — they are attached as a `cause: { kind: "yaml-parse-error" | "yaml-non-mapping", ... }` field on the single uniform outer `onError` call, so consumers can ship one recovery handler across every protocol. Complements the existing `unfinished-tool-call` and `malformed-nested-tool-call` reasons from #296 and #299
