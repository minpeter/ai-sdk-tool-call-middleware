---
"@ai-sdk-tool/parser": patch
---

Remove CommonJS builds and make the package ESM-only. Consumers must replace
`require("@ai-sdk-tool/parser")` with ESM `import` or dynamic `import()`.

Switch the JavaScript build to tsdown and publish Node-compatible declarations
for every package entrypoint.
