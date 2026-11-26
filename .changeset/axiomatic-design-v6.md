---
"@ai-sdk-tool/parser": major
---

Complete MIT Axiomatic Design architectural refactoring with orthogonal strategies, strict file-level DAG boundaries, and generate/stream diagnostic parity:

- **Orthogonal prompt and history strategies** on `createToolMiddleware` and `transformParams`:
  - Replace ad-hoc `toolSystemPromptTemplate`, `placement`, `toolSystemPromptMessages`, and `preserveNativeToolHistory` knobs with `promptStrategy` (`{ mode: "text", toolSystemPromptTemplate, placement? }` | `{ mode: "messages", buildMessages }`) and `historyStrategy` (`{ mode: "converted-text" }` | `{ mode: "provider-native" }`).
  - Unify default system prompt placement via `DEFAULT_TOOL_SYSTEM_PROMPT_PLACEMENT = "last"` across both `createToolMiddleware` and `transformParams`.
- **First-class `TCMProtocol` capabilities**:
  - Promote `isDefinitelyPlainGeneratedText` and `allowsFallbackRecovery` (replacing `allowsGeneratedTextJsonRecovery`) directly onto `TCMProtocol`, removing the WeakMap fast-path registry backdoor.
- **Strict user vs. internal transport state isolation**:
  - Move middleware-managed transport state (`originalTools`, `toolChoice`, `droppedProviderTools`) under `providerOptions.toolCallMiddleware._internal`, keeping top-level `providerOptions.toolCallMiddleware` reserved for caller options (`onError`, `emitRawToolCallTextOnError`, `debugSummary`).
- **Generate & stream `debugSummary` parity**:
  - Record `providerOptions.toolCallMiddleware.debugSummary` symmetrically in both `wrapGenerate` and `wrapStream` (including forced `toolChoice` streams).
- **Removed legacy aliases & bespoke transform**:
  - Remove deprecated aliases `TCMCoreProtocol`, `isTCMProtocolFactory`, `Qwen3CoderToolParser`, `uiTarsXmlProtocol`, `KExaone2ToolParser`, `KExaone236BToolParser`, and standalone `transformKExaone236BParams` (unified through `createToolMiddleware` + `kExaone236BToolMiddleware`).
- **Decoupled internal architecture & CI contract enforcement**:
  - Extract zero-dependency `src/shared/` primitives, eliminate the `schema-coerce` ⇄ `rxml` cycle, organize `src/core/protocols/` by protocol family and `src/core/utils/` by functional subdomain, and enforce strict layer + file-level Tarjan SCC acyclicity in CI.
