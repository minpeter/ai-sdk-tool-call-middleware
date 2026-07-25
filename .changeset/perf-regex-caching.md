---
"@ai-sdk-tool/parser": patch
---

Cache tool end-tag and schema property tag regexes in the morph-xml
streaming hot paths instead of recompiling them on every chunk.
