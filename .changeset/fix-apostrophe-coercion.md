---
"@ai-sdk-tool/parser": patch
---

fix(schema-coerce): try JSON.parse before replacing apostrophes

Previously, `coerceStringToArray()` and `coerceStringToObject()` blindly replaced all single quotes with double quotes before `JSON.parse()`, corrupting valid JSON values containing apostrophes (e.g. `it's`, `don't`, `skill'leri`). Now the original string is parsed first, with single-quote replacement only as a fallback.
