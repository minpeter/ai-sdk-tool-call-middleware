---
"@ai-sdk-tool/parser": patch
---

Amortize qwen3coder streaming call-buffer scans: once the buffer of a
streaming call exceeds 4KB, full rescans (close-tag search, next-call
search, parameter re-parse) run only after ~1/8 growth, with a catch-up
scan before finish reconciliation. Final results are unchanged; a
~173KB streamed string argument now parses ~120x faster with linear
instead of quadratic scaling. Behavior below 4KB is byte-identical.
