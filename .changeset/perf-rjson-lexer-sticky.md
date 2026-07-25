---
"@ai-sdk-tool/parser": patch
---

Switch the rjson lexer to sticky-flag regexes with offset tracking,
removing per-token string slicing and per-token regex line counting.
