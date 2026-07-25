---
"@ai-sdk-tool/parser": patch
---

Make morph-xml streaming tool-call parsing incremental: accumulated
content is kept in chunk parts (no per-chunk rope flattening), closing
tags are scanned only in the unproven tail, and streaming progress is
reused while appended text is provably inert. Large streamed string
arguments (~173KB) now parse ~40x faster with linear instead of
quadratic scaling.
