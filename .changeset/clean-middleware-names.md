---
"@ai-sdk-tool/eval": major
"@ai-sdk-tool/opencode-plugin": major
"@ai-sdk-tool/proxy": major
---

Remove gemma support and rename middleware functions

- Remove gemmaToolMiddleware and related code
- Rename morphXmlToolMiddleware to xmlToolMiddleware
- Rename orchestratorToolMiddleware to ymlToolMiddleware
- Update all imports, exports, and documentation