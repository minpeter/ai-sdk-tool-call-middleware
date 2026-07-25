---
"@ai-sdk-tool/parser": patch
---

Amortize hermes streaming tool-call JSON scans: once the accumulated
tool-call body exceeds 4KB, full boundary rescans and progress
recomputation run only after ~1/8 growth, with a cheap carry-based
close-tag trigger for same-chunk completion and a catch-up scan before
finish reconciliation. Final results are unchanged; a ~177KB streamed
string argument now parses ~50x faster with linear instead of quadratic
scaling. Behavior below 4KB is byte-identical.
