---
"@ai-sdk-tool/parser": minor
---

Remove CommonJS builds and make the package ESM-only. Consumers must replace
`require("@ai-sdk-tool/parser")` with ESM `import` or dynamic `import()`.
