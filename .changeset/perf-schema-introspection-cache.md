---
"@ai-sdk-tool/parser": patch
---

Memoize morph-xml schema introspection (property-name sets, array-type
checks) by schema object identity so streamed chunks stop re-walking
tool input schemas.
