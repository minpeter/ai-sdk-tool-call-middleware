---
"@ai-sdk-tool/parser": major
---

Migrate to AI SDK v7 (provider specification v4).

- The middleware now declares `specificationVersion: "v4"` and uses the `LanguageModelV4*` provider types. **This release requires `ai@^7` / `@ai-sdk/provider@^4` and is no longer compatible with the AI SDK v6 line.**
- Tool-result file parts now use the v4 tagged `SharedV4FileData` shape (`{ type: "data", data }`) instead of a bare `data` string.
- `@ai-sdk/provider` and `@ai-sdk/provider-utils` are now **peerDependencies** (rather than bundled dependencies) so the middleware shares the host application's provider types and avoids duplicate-package type mismatches. `@ai-sdk/openai` moved to devDependencies (used only by examples/tests).
