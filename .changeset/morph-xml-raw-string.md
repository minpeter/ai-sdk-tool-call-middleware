---
"@ai-sdk-tool/parser": patch
---

Preserve raw inner text for string-typed arguments in Morph-XML protocol; add tests; adjust examples.

- XML parser now prefers raw inner content for properties typed as string
- Adds unit tests for parse and streaming cases
