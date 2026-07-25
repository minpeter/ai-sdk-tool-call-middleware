---
"@ai-sdk-tool/parser": patch
---

Add fast paths to XML escape/unescape helpers for content without
escapable characters, and skip JSON whitespace with charCode checks on
the hermes streaming path.
