---
"@ai-sdk-tool/parser": patch
---

Live-model hardening and AI SDK v7 spec-parity fixes.

Parsing robustness (from a 12-model live matrix over 7 scenarios):

- qwen3coder: recover schema-property parameter tags (`<path>…</path>`),
  `<function>NAME</function>` name-as-text openers, `function=NAME>` openers
  missing `<`, bare tool names after `<tool_call>`, and literal `<value>`
  element wrappers; add a finish-time XML salvage backstop
- qwen3coder streaming: concatenated `tool-input-delta` chunks now always
  reconcile with the final tool-call input (closing-tag fragments, boundary
  whitespace, and split surrogate pairs are held back)
- yaml-xml: schema-keyed salvage for unquoted multi-line string scalars
  (e.g. Python docstrings) and cross-format recovery of Hermes-style
  `<tool_call>` JSON payloads in both generate and stream paths
- JSON recovery: accept `function` as a tool-name envelope key

AI SDK v7 (LanguageModelV4) spec parity:

- protocol stream parsers consume provider `text-start`/`text-end` envelopes
  instead of leaking empty duplicate text blocks
- forced tool choice scans all content parts for the JSON text, keeps
  reasoning content, reports missing text via `onError`, and preserves
  `length`/`content-filter`/`error` finish reasons
- `toolChoiceStream` emits `response-metadata` and re-emits reasoning
- provider-executed tool calls pass through byte-identical and no longer
  trigger the `tool-calls` finish rewrite
- dropped provider tools surface as `unsupported` warnings
