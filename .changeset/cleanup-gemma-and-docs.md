---
"@ai-sdk-tool/parser": patch
"@ai-sdk-tool/eval": patch
"@ai-sdk-tool/middleware": patch
"@ai-sdk-tool/proxy": patch
---

feat: Implement PR #141 review feedback - clean up gemma support and fix documentation

- Remove all gemma model references and configurations across codebase
- Fix broken README examples by adding proper model and middleware imports
- Change xmlToolMiddleware placement from "first" to "last" for consistency
- Fix yamlToolMiddleware import name in benchmark scripts
- Update ai dependency from 6.0.5 to 6.0.6
- Add missing transformParams to disk cache middleware