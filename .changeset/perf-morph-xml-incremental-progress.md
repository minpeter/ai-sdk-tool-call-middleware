---
"@ai-sdk-tool/parser": patch
---

Make morph-xml streaming tool-call parsing incremental and live-stream
trailing string values: accumulated content is kept in chunk parts (no
per-chunk rope flattening), closing tags are scanned only in the
unproven tail, and strictly string-typed trailing values now emit
tool-input deltas in ~1KB bursts while streaming (previously the whole
value arrived as one delta when the tag closed). Large streamed string
arguments (~173KB) parse ~12x faster with bounded instead of quadratic
scan work.
