---
"@ai-sdk-tool/parser": patch
---

Amortize hermes streaming tool-call JSON scans: once the accumulated
tool-call body exceeds 4KB, full boundary rescans and progress
recomputation run on a capped ~1KB cadence instead of every chunk, with
a carry-based close-tag trigger for same-chunk completion and a
catch-up scan before finish reconciliation. Final results are
unchanged and tool-input deltas keep a steady cadence; a ~177KB
streamed string argument now parses ~20x faster. Behavior below 4KB is
byte-identical.
