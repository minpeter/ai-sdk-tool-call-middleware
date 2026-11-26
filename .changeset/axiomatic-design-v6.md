---
"@ai-sdk-tool/parser": major
---

Complete MIT Axiomatic Design architectural refactoring with orthogonal strategies, strict file-level DAG boundaries, transport-state isolation, and generate/stream diagnostic parity.

### Breaking changes & migration (`v5` → `v6`)

- **Orthogonal `promptStrategy` and `historyStrategy`** on `createToolMiddleware` and `transformParams`:

| v5 option | v6 replacement |
|---|---|
| `toolSystemPromptTemplate` | `promptStrategy: { mode: "text", template }` |
| `placement` | `promptStrategy: { mode: "text", template, placement }` |
| `suppressToolSystemPromptForForcedChoice` | `promptStrategy: { ..., suppressForForcedChoice }` |
| custom multi-message transform (`transformKExaone236BParams`) | `promptStrategy: { mode: "messages", build, suppressForForcedChoice? }` |
| `historyMode: "converted-text"` (default) | `historyStrategy: { mode: "converted-text", toolResponsePromptTemplate? }` |
| `toolResponsePromptTemplate` | `historyStrategy: { mode: "converted-text", toolResponsePromptTemplate }` |
| `historyMode: "provider-native"` | `historyStrategy: { mode: "provider-native" }` |

  Example (`mode: "text"` + `converted-text` history):

  ```ts
  import {
    createHermesToolResponseFormatter,
    createToolMiddleware,
    hermesProtocol,
    hermesSystemPromptTemplate,
  } from "@ai-sdk-tool/parser";

  const middleware = createToolMiddleware({
    protocol: hermesProtocol(),
    promptStrategy: {
      mode: "text",
      template: hermesSystemPromptTemplate,
      placement: "last",
      suppressForForcedChoice: false,
    },
    historyStrategy: {
      mode: "converted-text",
      toolResponsePromptTemplate: createHermesToolResponseFormatter(),
    },
  });
  ```

  Example (`mode: "messages"` + `provider-native` history):

  ```ts
  import {
    createToolMiddleware,
    kExaone236BProtocol,
    kExaone236BSystemPromptMessages,
  } from "@ai-sdk-tool/parser";

  const middleware = createToolMiddleware({
    protocol: kExaone236BProtocol,
    promptStrategy: {
      mode: "messages",
      build: kExaone236BSystemPromptMessages,
      suppressForForcedChoice: true,
    },
    historyStrategy: { mode: "provider-native" },
  });
  ```

- **Unified `transformParams` default placement**:
  - `transformParams` now defaults `promptStrategy.placement` to `DEFAULT_TOOL_SYSTEM_PROMPT_PLACEMENT` (`"last"`), matching `createToolMiddleware`. (In `v5`, calling `transformParams` directly defaulted `placement` to `"first"`.) Pass `placement: "first"` explicitly if you relied on the old `transformParams` default.
- **First-class `TCMProtocol` capabilities**:
  - Promote `isDefinitelyPlainGeneratedText` and `allowsFallbackRecovery` (replacing `allowsGeneratedTextJsonRecovery`) directly onto `TCMProtocol`, removing the WeakMap fast-path registry backdoor.
- **Strict user vs. internal transport state isolation**:
  - Middleware-managed transport state (`originalTools`, `toolChoice`, `droppedProviderTools`) is written fresh per request under `providerOptions.toolCallMiddleware._internal`, stripped before invoking the underlying provider model, and omitted from `ParserOptions` passed to protocol parsers.
  - Direct callers of `wrapGenerate` / `wrapStream` that previously injected top-level `providerOptions.toolCallMiddleware.originalTools` or `toolChoice` should obtain transformed params via `transformParams` (or pass the middleware-produced `providerOptions`).
  - Internal `_internal` helpers and `decodeOriginalToolsForMiddleware` are no longer exported from the package root.
- **Generate & stream `debugSummary` parity**:
  - Record `providerOptions.toolCallMiddleware.debugSummary` symmetrically in both `wrapGenerate` and `wrapStream` (including empty responses, multi-block text, and forced `toolChoice` streams).
- **Removed legacy aliases & bespoke transform**:
  - Remove deprecated aliases `TCMCoreProtocol`, `isTCMProtocolFactory`, `Qwen3CoderToolParser`, `uiTarsXmlProtocol`, `KExaone2ToolParser`, `KExaone236BToolParser`, and standalone `transformKExaone236BParams` (unified through `createToolMiddleware` + `kExaone236BToolMiddleware`).
- **Decoupled internal architecture & CI contract enforcement**:
  - Extract zero-dependency `src/shared/` primitives, eliminate the `schema-coerce` ⇄ `rxml` cycle, organize `src/core/protocols/` by protocol family (`glm5`, `hermes`, `k-exaone`, `morph-xml`, `qwen3coder`, `yaml-xml`) and `src/core/utils/` into 11 functional subdomains, and enforce strict layer + file-level Tarjan SCC acyclicity and a 600-LOC ceiling in CI.
