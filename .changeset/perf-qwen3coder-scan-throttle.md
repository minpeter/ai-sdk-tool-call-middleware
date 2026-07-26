---
"@ai-sdk-tool/parser": patch
---

Amortize qwen3coder streaming call-buffer scans: once the buffer of a
streaming call exceeds 4KB, full rescans (close-tag search, next-call
search, parameter re-parse) run on a capped ~1KB cadence instead of
every chunk, with a carry-based close-tag trigger for same-chunk
completion and a catch-up scan before finish reconciliation. Final
results are unchanged and tool-input deltas keep a steady cadence; a
~173KB streamed string argument now parses ~30x faster. Behavior below
4KB is byte-identical.
