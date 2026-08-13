---
"@ai-sdk-tool/parser": patch
---

Add an experimental Friendli K-EXAONE-236B middleware preset with byte-matched
native tool declarations, structured reasoning/tool history replay, Hermes JSON
calls, and a separate system guide that keeps unconstrained generation on the
Hermes tool-call format.

Reject provider-defined tools consistently before prompt transformation instead
of dropping them with a warning; the prompt-based middleware accepts function
tools only.
