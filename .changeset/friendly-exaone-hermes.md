---
"@ai-sdk-tool/parser": patch
---

Add an experimental Friendli K-EXAONE-236B middleware preset with byte-matched
native tool declarations, structured reasoning/tool history replay, Hermes JSON
calls, and a separate system guide that keeps unconstrained generation on the
Hermes tool-call format. Existing provider-defined tools remain unsupported by
the prompt format and continue to be dropped with an unsupported-feature
warning.
