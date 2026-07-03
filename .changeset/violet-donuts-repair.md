---
"@ai-sdk-tool/parser": minor
---

Close generate/stream behavior gaps found by auditing the AI SDK v7 (provider v4) spec surface and by live-testing every protocol against current open models (GLM-4.7, Qwen2.5, Kimi K2.5, gpt-oss, Llama 3.1).

Features:

- `toolChoice: { type: "none" }` is now supported instead of throwing. Tool definitions are not injected, tool-call history is still serialized, and both wrap handlers pass the model output through without tool parsing.
- Streaming bare-JSON tool-call recovery: text blocks that consist of a bare `{"name": ..., "arguments": ...}` payload (or a fenced ```json block) are now recovered into proper tool calls in `streamText`, matching the long-standing generate-path recovery. Observed live on GLM-4.7 with the Hermes protocol, which previously leaked the JSON as visible text.
- JSON-candidate recovery is now multi-call: consecutive payloads separated by newlines or orphan `<tool_call>` tags (GLM-4.7's parallel-call shape, previously 0 recovered calls) are all recovered, in both generate and stream paths.
- Forced-tool-choice streams now emit the full spec lifecycle: `stream-start` (with the underlying model's warnings), `tool-input-start`/`tool-input-delta`/`tool-input-end` reconciled to the final `tool-call` id, and `finish` carrying the model's `providerMetadata`.

Fixes:

- `wrapGenerate` now rewrites `finishReason` to `tool-calls` when tool calls were parsed from text (parity with the stream path and native providers); meaningful reasons like `length` are preserved. The stream-path rewrite now also covers `unified: "other"`.
- Canonical v4 `type: "file"` tool-result content parts (tagged `data`/`url`/`reference`/`text` file data) are now normalized properly instead of degrading to `[Unknown content]`.
- Hermes: tool calls closed with a mismatched tag (e.g. `<tool_call>{...}</think>`, observed live on GLM-4.7) are salvaged in both parse paths, with the same argument key policy and prototype-pollution guards as the primary parser. Orphan `<tool_call>` fragments no longer leak into recovered text.
- Qwen3-Coder: the nameless `<parameter>city</parameter>Seoul` variant (observed live on Qwen2.5-7B, which previously produced empty `{}` inputs) is now parsed in both generate and stream paths.
- Qwen3-Coder streaming no longer freezes text delivery until finish when prose contains tag-like substrings such as `<callback>` or `<toolbar>`.
- YAML-XML streaming no longer withholds a fixed `maxTagLen - 1` tail on every chunk; only genuine partial tool-tag suffixes are held back.
- JSON-candidate recovery now rejects prototype-sensitive keys (`__proto__`, `constructor`, `prototype`) textually, closing a gap where relaxed-JSON parsing could absorb them past the post-parse guard.

Additional hardening from a second live matrix over 12 more models (DeepSeek V3.2, GLM-5, MiniMax M2.5, Ministral 8B, Nemotron Nano 9B, Granite 4.0, Nova 2 Lite, Seed 2.0 Mini, Solar Pro 3, Llama 3.3 70B, Qwen3 30B-A3B, Step 3.5 Flash):

- Hermes accepts double-encoded `arguments` (a JSON string containing the object — the OpenAI native wire habit, observed live on IBM Granite 4.0) in both parse paths, still subject to the argument key policy.
- Array-wrapped call lists (`<tool_call>[{...}, {...}]</tool_call>`, observed live on ByteDance Seed 2.0) are salvaged into individual tool calls in both parse paths.
- The generic JSON recovery accepts `tool`/`parameters` envelope key aliases (observed live on NVIDIA Nemotron Nano) and unwraps double-encoded arguments.
- YAML-XML falls back to parsing `<key>value</key>` child tags when the tool body is XML instead of YAML (observed live on Amazon Nova 2 Lite).
- The streaming recovery stage also holds blocks that start with a JSON array or a literal `<tool_call>` tag leaking through a foreign protocol.

Internal: dead `speculativeToolCall` state and an unreachable `flushBuffer` branch were removed from the Hermes stream parser.
