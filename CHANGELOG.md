# @ai-sdk-tool/parser

## 5.1.2

### Patch Changes

- ca023c9: Drop schema-unknown tool-call arguments consistently across parser middleware while preserving prototype-sensitive key rejection and strict required-key normalization.
- a1236c6: Default tool-result media handling now passes real AI SDK v4/v7 `file` parts (`mode: "model"`) instead of text placeholders.

  - Canonical `{ type: "file", data: SharedV4FileData }` content is forwarded as model file parts; non-canonical content becomes placeholders.
  - Hermes, Morph XML, and Qwen3-Coder formatters emit hybrid user content (`text` wrapper + adjacent `file` parts) when media is present. YAML XML tool responses reuse the Morph XML response formatter (same hybrid behavior by default).
  - Opt into the old text-only path with `mediaStrategy: { mode: "placeholder" }` via `createHermesToolResponseFormatter` / `createMorphXmlToolResponseFormatter` / `createQwen3CoderXmlToolResponseFormatter` (YAML XML apps should use the Morph factory for response formatting options).
  - URL-backed file parts only forward `http:` / `https:` URLs; other schemes degrade to placeholders. String URLs are intentionally reparsed to `URL` (JSON-deserialized payloads).
  - Remove the `raw` media strategy mode (use `model`, `placeholder`, or capability-gated `auto`).

## 5.1.1

### Patch Changes

- e6e3224: Maintenance release: adopt ultracite 7.9.0 lint rules via mechanical refactors (destructuring, `+= 1` counters, property-style interface signatures — no behavior changes), refresh dev dependencies (`ai`, `@ai-sdk/openai`, `ultracite`), and force patched `js-yaml` transitives to clear security advisories.

## 5.1.0

### Minor Changes

- e337981: Close generate/stream behavior gaps found by auditing the AI SDK v7 (provider v4) spec surface and by live-testing every protocol against current open models (GLM-4.7, Qwen2.5, Kimi K2.5, gpt-oss, Llama 3.1).

  Features:

  - `toolChoice: { type: "none" }` is now supported instead of throwing. Tool definitions are not injected, tool-call history is still serialized, and both wrap handlers pass the model output through without tool parsing.
  - Streaming bare-JSON tool-call recovery: text blocks that consist of a bare `{"name": ..., "arguments": ...}` payload (or a fenced ```json block) are now recovered into proper tool calls in `streamText`, matching the long-standing generate-path recovery. Observed live on GLM-4.7 with the Hermes protocol, which previously leaked the JSON as visible text.
  - JSON-candidate recovery is now multi-call: consecutive payloads separated by newlines or orphan `<tool_call>` tags (GLM-4.7's parallel-call shape, previously 0 recovered calls) are all recovered, in both generate and stream paths.
  - Forced-tool-choice streams now emit the full spec lifecycle: `stream-start` (with the underlying model's warnings), `tool-input-start`/`tool-input-delta`/`tool-input-end` reconciled to the final `tool-call` id, and `finish` carrying the model's `providerMetadata`.

  Fixes:

  - `wrapGenerate` now rewrites `finishReason` to `tool-calls` when tool calls were parsed from text (parity with the stream path and native providers); meaningful reasons like `length` are preserved. The stream-path rewrite now also covers `unified: "other"`.
  - Canonical v4 `type: "file"` tool-result content parts (tagged `data`/`url`/`reference`/`text` file data) are now normalized properly instead of degrading to `[Unknown content]`.
  - Hermes: tool calls closed with a mismatched tag (e.g. `<tool_call>{...}</think>`, observed live on GLM-4.7) are salvaged in both parse paths, with the same argument key policy and prototype-pollution guards as the primary parser. Orphan `<tool_call>` fragments no longer leak into recovered text.
  - Qwen3-Coder: the nameless `<parameter>city</parameter>Seoul` variant (observed live on Qwen2.5-7B, which previously produced empty `{}` inputs) is now parsed in both generate and stream paths.
  - Qwen3-Coder streaming no longer freezes text delivery until finish when prose contains tag-like substrings such as `<callback>` or `<toolbar>`.
  - YAML-XML streaming no longer withholds a fixed `maxTagLen - 1` tail on every chunk; only genuine partial tool-tag suffixes are held back.
  - JSON-candidate recovery now rejects prototype-sensitive keys (`__proto__`, `constructor`, `prototype`) textually, closing a gap where relaxed-JSON parsing could absorb them past the post-parse guard.

  Additional hardening from a second live matrix over 12 more models (DeepSeek V3.2, GLM-5, MiniMax M2.5, Ministral 8B, Nemotron Nano 9B, Granite 4.0, Nova 2 Lite, Seed 2.0 Mini, Solar Pro 3, Llama 3.3 70B, Qwen3 30B-A3B, Step 3.5 Flash):

  - Hermes accepts double-encoded `arguments` (a JSON string containing the object — the OpenAI native wire habit, observed live on IBM Granite 4.0) in both parse paths, still subject to the argument key policy.
  - Array-wrapped call lists (`<tool_call>[{...}, {...}]</tool_call>`, observed live on ByteDance Seed 2.0) are salvaged into individual tool calls in both parse paths.
  - The generic JSON recovery accepts `tool`/`parameters` envelope key aliases (observed live on NVIDIA Nemotron Nano) and unwraps double-encoded arguments.
  - YAML-XML falls back to parsing `<key>value</key>` child tags when the tool body is XML instead of YAML (observed live on Amazon Nova 2 Lite).
  - The streaming recovery stage also holds blocks that start with a JSON array or a literal `<tool_call>` tag leaking through a foreign protocol.

  A third pass with schema-diversity scenarios (nested objects, arrays, code content with quotes/newlines, no-arg tools, multi-tool selection, unicode values) across 14 more models (Kimi K2.6, Cohere Command R+, AI21 Jamba, LiquidAI LFM2, LG EXAONE, Longcat, Xiaomi MiMo, Tencent HY3, KAT Coder, Gemma 4, Mistral Small, Cogito 671B + controls) hardened:

  - schema coercion: object/array-typed parameters delivered as strings now parse through strict JSON → relaxed JSON → Python-literal normalization (`True`/`False`/`None`, observed on KAT Coder) → line-oriented XML children (observed on Cohere Command R+), with prototype-key guards.
  - cross-format recovery: the shared recovery layer now also resolves Qwen-style `<function=name><parameter=key>value` blocks (Step 3.5 Flash emits these under every prompt) and `<tool_call>` blocks with YAML mapping bodies closed by arbitrary tags (IBM Granite 4.0's native shape), in every middleware.
  - hermes: invalid JSON escapes inside string values (e.g. `\$` from template literals in generated code, observed on Command R+) are normalized before parsing.
  - qwen3coder: Hermes-style JSON payloads inside `<tool_call>` tags (observed on LiquidAI LFM2) are salvaged at stream finish instead of dropped.

  Internal: dead `speculativeToolCall` state and an unreachable `flushBuffer` branch were removed from the Hermes stream parser.

### Patch Changes

- b92373d: Live-model hardening and AI SDK v7 spec-parity fixes.

  Parsing robustness (from a 12-model live matrix over 7 scenarios):

  - qwen3coder: recover schema-property parameter tags (`<path>…</path>`),
    `<function>NAME</function>` name-as-text openers, `function=NAME>` openers
    missing `<`, bare tool names after `<tool_call>`, and literal `<value>`
    element wrappers; add a finish-time XML salvage backstop
  - qwen3coder streaming: concatenated `tool-input-delta` chunks now always
    reconcile with the final tool-call input (closing-tag fragments, boundary
    whitespace, and split surrogate pairs are held back)
  - yaml-xml: schema-keyed salvage for unquoted multi-line string scalars
    (e.g. Python docstrings) and cross-format recovery of Hermes-style
    `<tool_call>` JSON payloads in both generate and stream paths
  - JSON recovery: accept `function` as a tool-name envelope key

  AI SDK v7 (LanguageModelV4) spec parity:

  - protocol stream parsers consume provider `text-start`/`text-end` envelopes
    instead of leaking empty duplicate text blocks
  - forced tool choice scans all content parts for the JSON text, keeps
    reasoning content, reports missing text via `onError`, and preserves
    `length`/`content-filter`/`error` finish reasons
  - `toolChoiceStream` emits `response-metadata` and re-emits reasoning
  - provider-executed tool calls pass through byte-identical and no longer
    trigger the `tool-calls` finish rewrite
  - dropped provider tools surface as `unsupported` warnings

## 5.0.1

### Patch Changes

- cda8925: Recover XML tool calls whose body is malformed plain visible message text.

## 5.0.0

### Major Changes

- 17cf35a: Migrate to AI SDK v7 (provider specification v4).

  The v5 line is now the stable `latest` release line. Install it with `pnpm add @ai-sdk-tool/parser`.

  - The middleware now declares `specificationVersion: "v4"` and uses the `LanguageModelV4*` provider types. **This release requires `ai@^7` / `@ai-sdk/provider@^4` and is no longer compatible with the AI SDK v6 line.**
  - Tool-result file parts now use the v4 tagged `SharedV4FileData` shape (`{ type: "data", data }`) instead of a bare `data` string.
  - `@ai-sdk/provider` and `@ai-sdk/provider-utils` are now **peerDependencies** (rather than bundled dependencies) so the middleware shares the host application's provider types and avoids duplicate-package type mismatches. `@ai-sdk/openai` moved to devDependencies (used only by examples/tests).
  - **Node.js `>=22` is now required** (was `>=18`); Node 18 and 20 are no longer supported.

### Patch Changes

- ed665b4: Move the dummy protocol test fixture out of production source, mark the package
  as side-effect free for bundlers, and remove unused direct dev dependencies.
- 5a24435: Refresh the AI SDK v7 dependency stack and raise the provider peer lower
  bounds to the stable 4/5 release lines.

## 5.0.0-beta.1

### Patch Changes

- ed665b4: Move the dummy protocol test fixture out of production source, mark the package
  as side-effect free for bundlers, and remove unused direct dev dependencies.
- 5a24435: Refresh the AI SDK v7 beta dependency stack and raise the provider peer lower
  bounds to the latest beta line.

## 5.0.0-beta.0

### Major Changes

- 17cf35a: Migrate to AI SDK v7 (provider specification v4).

  This is a pre-release on the `beta` npm dist-tag; the v4.x line remains on `latest`. Install the v7 line with `pnpm add @ai-sdk-tool/parser@beta`.

  - The middleware now declares `specificationVersion: "v4"` and uses the `LanguageModelV4*` provider types. **This release requires `ai@^7` / `@ai-sdk/provider@^4` and is no longer compatible with the AI SDK v6 line.**
  - Tool-result file parts now use the v4 tagged `SharedV4FileData` shape (`{ type: "data", data }`) instead of a bare `data` string.
  - `@ai-sdk/provider` and `@ai-sdk/provider-utils` are now **peerDependencies** (rather than bundled dependencies) so the middleware shares the host application's provider types and avoids duplicate-package type mismatches. `@ai-sdk/openai` moved to devDependencies (used only by examples/tests).
  - **Node.js `>=22` is now required** (was `>=18`); Node 18 and 20 are no longer supported.

## 4.1.26

### Patch Changes

- 99d5f73: Refresh the AI SDK v6 dependency stack and development tooling, including
  provider-utils security hardening.

## 4.1.25

### Patch Changes

- d217a29: fix: repair malformed JSON with unescaped quotes in tool call arguments

## 4.1.24

### Patch Changes

- ced3966: deps: bump `@ai-sdk/openai` from `3.0.64` to `3.0.65` (#323)

  - `@ai-sdk/openai`: `3.0.64` → `3.0.65`

## 4.1.23

### Patch Changes

- fcbd7f1: deps: bump `yaml` from `2.8.4` to `2.9.0` (#316)

  - `yaml`: `2.8.4` → `2.9.0`

## 4.1.22

### Patch Changes

- 4070213: deps: bump `@ai-sdk/openai`, `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `yaml` (#314)

  - `@ai-sdk/openai`: `3.0.53` → `3.0.63`
  - `@ai-sdk/provider`: `3.0.8` → `3.0.10`
  - `@ai-sdk/provider-utils`: `4.0.23` → `4.0.27`
  - `yaml`: `2.8.3` → `2.8.4`

## 4.1.21

### Patch Changes

- 19b985a: fix: align `onError` parse-fail metadata across all four protocols (Hermes, morph-xml, yaml-xml, qwen3coder). Malformed tool-call bodies now uniformly report `{ toolCall, toolName, toolCallId, dropReason: "malformed-tool-call-body" }`; unresolvable tool names in qwen3coder streaming report `dropReason: "unresolved-tool-name"`. Underlying YAML helper failures are no longer surfaced as separate `onError` calls — they are attached as a `cause: { kind: "yaml-parse-error" | "yaml-non-mapping", ... }` field on the single uniform outer `onError` call, so consumers can ship one recovery handler across every protocol. Complements the existing `unfinished-tool-call` and `malformed-nested-tool-call` reasons from #296 and #299
- 2e173e1: fix: skip `</tool_call>` end tags inside JSON string values
- 60e620d: fix: normalize raw control characters in JSON string values before parsing
- 091844d: feat: add streaming dropped-tool-call metadata to onError

## 4.1.20

### Patch Changes

- 666bebb: chore: update devDependency ai 6.0.152 → 6.0.154

## 4.1.19

### Patch Changes

- 133d1f1: chore: update dependencies @ai-sdk/openai 3.0.50 → 3.0.52, @ai-sdk/provider-utils 4.0.22 → 4.0.23, @ai-sdk/openai-compatible 2.0.38 → 2.0.41, @vitest/coverage-v8 4.1.2 → 4.1.3, ai 6.0.146 → 6.0.152, vitest 4.1.2 → 4.1.3

## 4.1.18

### Patch Changes

- 6372694: chore: update devDependencies @types/node 25.5.0 → 25.5.2, ai 6.0.144 → 6.0.146, ultracite 7.4.2 → 7.4.3

## 4.1.17

### Patch Changes

- 89e0547: chore(deps): bump @ai-sdk/openai, @ai-sdk/provider-utils, @ai-sdk/openai-compatible, and ai

## 4.1.16

### Patch Changes

- 3affd37: Bump ai from 6.0.141 to 6.0.142 and ultracite from 7.4.0 to 7.4.2

## 4.1.15

### Patch Changes

- 4e1b4fe: Bump @ai-sdk/openai from 3.0.48 to 3.0.49 and @biomejs/biome from 2.4.9 to 2.4.10

## 4.1.14

### Patch Changes

- c6d8734: bump dev dependencies: @vitest/coverage-v8, ai, ultracite, vitest

## 4.1.13

### Patch Changes

- defd244: chore(deps-dev): bump @biomejs/biome from 2.4.8 to 2.4.9

## 4.1.12

### Patch Changes

- 106abf5: bump dependencies: @ai-sdk/openai, @vitest/coverage-v8, ai, typescript, vitest
- 47aa899: bump dependencies: ai

## 4.1.11

### Patch Changes

- bd095ce: bump dependencies: @ai-sdk/openai, @vitest/coverage-v8, ai, typescript, vitest

## 4.1.10

### Patch Changes

- 6d75339: chore(deps): bump @ai-sdk/openai, @ai-sdk/provider-utils, @ai-sdk/openai-compatible, ai, and yaml

## 4.1.9

### Patch Changes

- 9eb7eaf: chore(deps-dev): bump @biomejs/biome from 2.4.7 to 2.4.8

## 4.1.8

### Patch Changes

- 91bffa8: bump ultracite from 7.3.1 to 7.3.2

## 4.1.7

### Patch Changes

- cbcc455: Update dev dependencies: @biomejs/biome 2.4.6 → 2.4.7, ultracite 7.3.0 → 7.3.1

## 4.1.6

### Patch Changes

- 999fceb: Bump @types/node, @vitest/coverage-v8, ultracite, and vitest dev dependencies

## 4.1.5

### Patch Changes

- 0057235: Bump @types/node from 25.3.5 to 25.4.0

## 4.1.4

### Patch Changes

- 3ed6efa: chore(deps-dev): bump @types/node from 25.3.4 to 25.3.5

## 4.1.3

### Patch Changes

- 1f8b516: Add `inputExamples` prompt rendering support across all built-in middleware templates, including Hermes, Morph XML, YAML XML, Qwen3Coder, and community presets (UI-TARS and Sijawara variants).

  Introduce shared input-example rendering utilities and add regression tests to verify the rendered examples appear in system prompts when tool `inputExamples` are provided.

## 4.1.2

### Patch Changes

- e08ff92: Improve Morph XML tool-call prompting with clearer decision/output rules and stronger example guidance.

  Add a parser-core demo script plus fixture to inspect how `inputExamples` render into the Morph XML system prompt across single-tool and multi-tool scenarios.

- c9cda8b: Add cross-protocol regression coverage for literal angle-bracket tool argument values in both generated-text parsing and character-by-character streaming parsing paths.

## 4.1.1

### Patch Changes

- 8e499fb: Fix morph XML streaming end-tag matching by escaping tool names before building the closing-tag regex.
  This preserves correct parsing for tool names with regex metacharacters (for example `weather.v2`) and prevents premature or missed tool-call termination in stream output.

## 4.1.0

### Minor Changes

- 097a6fb: Add a new `model` media strategy mode for tool-result handling so tool `content` outputs can be converted into model-recognizable user content parts (`text`/`file`) instead of placeholder-only text.

  Update tool-role message conversion and middleware typing to support structured tool-response template outputs, while preserving existing string-based formatter behavior.

  Improve prompt shared module naming clarity and align shared test ownership with the renamed modules.

- 097a6fb: Add Qwen3-Coder dedicated middleware and prompt/protocol support, including:

  - Qwen3-Coder specific system-prompt rendering aligned to the Qwen tool format.
  - Qwen3-Coder tool-response formatting and assistant tool-call text conversion flow.
  - Prompt-layer refactor that separates shared prompt utilities from protocol-specific prompt modules for better maintainability.

- 37933c7: Rename the JSON protocol surface from `jsonProtocol` to `hermesProtocol` and align Hermes prompt/tool-response behavior with the vLLM Hermes format.

  Expand Hermes-focused parser test coverage (including nested schema rendering) and update protocol/preconfigured middleware references to the new naming.

  Refresh README and example documentation, including parser-core example filename cleanup and an AI SDK compatibility matrix in the top-level README.

## 4.0.1

### Patch Changes

- 43fc0db: fix(schema-coerce): try JSON.parse before replacing apostrophes

  Previously, `coerceStringToArray()` and `coerceStringToObject()` blindly replaced all single quotes with double quotes before `JSON.parse()`, corrupting valid JSON values containing apostrophes (e.g. `it's`, `don't`, `skill'leri`). Now the original string is parsed first, with single-quote replacement only as a fallback.

## 4.0.0

### Major Changes

- 11778c6: Stream stable, monotonic JSON argument deltas for tool calls across protocols.

  - `hermesProtocol`: `tool-input-delta` streams canonical JSON argument text.
  - `morphXmlProtocol` and `yamlXmlProtocol`: `tool-input-delta` streams parsed JSON argument prefixes (not raw XML/YAML fragments).
  - Preserve ID reconciliation across `tool-input-start`, `tool-input-end`, and final `tool-call`.
  - Tool call ids are now generated in an OpenAI-like `call_` format.
  - Suppress raw protocol-markup fallback in streaming parse failures by default to avoid leaking internal markup to end users (opt-in via `emitRawToolCallTextOnError: true`).
  - Add tests and fixture updates for value-split/key-split streaming chunks, finish reconciliation, malformed paths, and fallback policy.

  **BREAKING CHANGE**: `emitRawToolCallTextOnError` now defaults to `false`. Previously, malformed streaming tool calls could emit raw protocol markup as `text-delta` fallback. Now this is opt-in. If you relied on this behavior, set `emitRawToolCallTextOnError: true` in your parser options.

## 3.3.3

### Patch Changes

- ff8ee41: Improve middleware robustness and compatibility with the latest AI SDK v6 patch releases.

  - Harden toolChoice JSON payload parsing with strict object validation and safe fallbacks.
  - Normalize tool-call argument coercion across both generate and stream paths.
  - Ensure stream protocol consistency by emitting `text-end` before `finish` when buffered text remains.
  - Safely decode persisted tool schemas from provider options and recover on malformed schema payloads.
  - Upgrade AI SDK-related dependencies to the latest patch versions.

- 4e00d44: Fix JSON tool-call recovery to prefer the earliest candidate and ignore nested payloads.

## 3.3.2

### Patch Changes

- 25b3c0e: Refactor codebase to eliminate code duplications and update dependencies

  ### Code Refactoring

  - Extract shared `escapeRegExp` function: removed duplicate from `rxml/heuristics/xml-defaults.ts`, now imports from `core/utils/regex.ts`
  - Create shared regex constants: new `core/utils/regex-constants.ts` exports `NAME_CHAR_RE` and `WHITESPACE_REGEX` used by protocol implementations
  - Extract shared `ParserOptions` interface: moved to `core/protocols/protocol-interface.ts` from duplicate definitions in `morph-xml-protocol.ts` and `yaml-xml-protocol.ts`
  - Create shared protocol utility: new `core/utils/protocol-utils.ts` exports `addTextSegment()` function, replacing duplicate implementations in `hermes-protocol.ts` and `yaml-xml-protocol.ts`

  ### Dependency Updates

  - Update `@ai-sdk/openai-compatible` from 2.0.26 to 2.0.27
  - Update `ai` from 6.0.69 to 6.0.70

  These changes improve code maintainability by consolidating ~40 lines of duplicated code into shared utilities, making future changes easier and reducing the risk of inconsistencies.

- d619370: Update development dependencies

  - Update `@types/node` from 25.2.0 to 25.2.1
  - Update `ai` from 6.0.70 to 6.0.73

## 3.3.1

### Patch Changes

- bc17084: Improve object-to-array coercion heuristics: consistently wrap objects in arrays when schema expects array type, handle single-key object extraction for XML patterns

## 3.3.0

### Minor Changes

- d7f6ba0: Convert monorepo structure to single package with subpath exports. All internal packages (rxml, rjson, schema-coerce) are now accessible via subpath imports (e.g., `@ai-sdk-tool/parser/rxml`).

## 3.2.1

### Patch Changes

- 4cdd469: Improve XML protocol self-closing tag parsing to handle whitespace variations and enhance system prompt template with dedent for cleaner formatting

## 3.2.0

### Minor Changes

- ef6536e: Refactor XML tool-call parsing to use rxml repair parsing options and more robust tag handling.
  Move XML repair heuristics into @ai-sdk-tool/rxml and add schema-coerce utilities for schema-driven coercion.

### Patch Changes

- cf61516: Simplify wrapStream by removing separate toolChoice branch handling
- Updated dependencies [ef6536e]
  - @ai-sdk-tool/rxml@0.2.0

## 3.1.3

### Patch Changes

- aa0b37b: Update AI SDK dependencies to latest versions

## 3.1.2

### Patch Changes

- ec30a4d: Improve formatToolCall XML output: add proper indentation/newlines and preserve quotes without HTML entity escaping

## 3.1.1

### Patch Changes

- 1400780: Handle tool calls with undefined/null input and clean up type casting. formatToolCall functions now handle null/undefined input gracefully. Replace manual type guards with discriminated union narrowing using switch statements. Extract extractSchemaProperties helper in xml-defaults.ts to reduce code duplication.

## 3.1.0

### Minor Changes

- b9b13bd: Major refactoring of tool call protocol interface and implementation.

  - Renamed ToolCallProtocol to TCMCoreProtocol with TCM prefix consistency
  - Renamed isProtocolFactory to isTCMProtocolFactory
  - Renamed file tool-call-protocol.ts to protocol-interface.ts
  - Reorganized protocol implementations with cleaner structure
  - Updated all type references and imports across the codebase

- b9b13bd: Change toolSystemPromptTemplate parameter type from string to TCMToolDefinition[] array and add TCM prefix to ToolDefinition and ToolInputExample types for better type safety and API clarity.

### Patch Changes

- b9b13bd: Simplify `formatToolResponseAsHermes` signature to match `morphFormatToolResponseAsXml` by removing optional tag parameters and hardcoding `<tool_response>` tags.
- b9b13bd: feat: Implement PR #141 review feedback - clean up gemma support and fix documentation

  - Remove all gemma model references and configurations across codebase
  - Fix broken README examples by adding proper model and middleware imports

- Change morphXmlToolMiddleware placement from "first" to "last" for consistency

  - Fix yamlXmlToolMiddleware import name in benchmark scripts
  - Update ai dependency from 6.0.5 to 6.0.6
  - Add missing transformParams to disk cache middleware

- b9b13bd: Fix type issues and variable references in tool response formatting refactoring
- b9b13bd: Fixed prompt normalization in v5 transform handler to handle single message objects, preventing runtime errors when params.prompt is a single ModelMessage instead of an array.
- b9b13bd: Fixed XML escaping in morphFormatToolResponseAsXml to prevent invalid XML when tool results contain special characters like < and & in JSON-serialized objects.
- b9b13bd: Sync v5 and v6 middleware implementations: extract shared prompts to `core/prompts/`, add orchestratorToolMiddleware to v5, unify morphXmlToolMiddleware placement, and add debug logging to v5 handlers

## 3.0.0

### Major Changes

- 537adc6: upgrade language model interfaces to V3
- 537adc6: bump ai v6 (middleware v3 not yet)

### Minor Changes

- 537adc6: feat(parser): implement pluggable heuristic pipeline for XML parsing

  - Add 3-phase heuristic engine (pre-parse, fallback-reparse, post-parse)
  - Add 5 default XML heuristics: normalizeCloseTags, escapeInvalidLt, balanceTags, dedupeShellStringTags, repairAgainstSchema
  - Reorganize heuristics into dedicated `src/heuristics/` module
  - Export heuristic APIs for custom pipeline configuration

- 537adc6: Remove internal barrel files and enable noBarrelFile linting rule for better tree-shaking and build performance
- 1fc1810: Add YAML+XML mixed tool call protocol (Orchestrator-style)
- Internal restructuring: consolidate v6 folder contents into main src directory, update all imports and exports accordingly

  - New `yamlXmlProtocol` for parsing tool calls with YAML content inside XML tags
  - New `yamlXmlToolMiddleware` pre-configured middleware
  - New `orchestratorSystemPromptTemplate` for customizable system prompts
  - Supports YAML multiline syntax (`|` and `>`)
  - Full streaming support with proper text/tool-call separation
  - Self-closing tags and empty bodies return `{}`

### Patch Changes

- 537adc6: minor dependency version bump
- Updated dependencies [537adc6]
  - @ai-sdk-tool/rxml@0.1.2

## 3.0.0-canary.3

### Patch Changes

- 1f36102: minor dependency version bump
- Updated dependencies [1f36102]
  - @ai-sdk-tool/rxml@0.1.2-canary.0

## 3.0.0-canary.2

### Minor Changes

- 68a4248: feat(parser): implement pluggable heuristic pipeline for XML parsing

  - Add 3-phase heuristic engine (pre-parse, fallback-reparse, post-parse)
  - Add 5 default XML heuristics: normalizeCloseTags, escapeInvalidLt, balanceTags, dedupeShellStringTags, repairAgainstSchema
  - Reorganize heuristics into dedicated `src/heuristics/` module
  - Export heuristic APIs for custom pipeline configuration

## 3.0.0-canary.1

### Minor Changes

- b48924c: Remove internal barrel files and enable noBarrelFile linting rule for better tree-shaking and build performance

## 3.0.0-canary.0

### Major Changes

- c96c293: upgrade language model interfaces to V3
- df62ec5: bump ai v6 (middleware v3 not yet)

## 2.1.7

### Patch Changes

- 4fb674f: Add community XML tools and reorganize parsers

## 2.1.6

### Patch Changes

- dce31fe: Add a debugging field that returns the original output of the model before parsing.

## 2.1.5

### Patch Changes

- c25f1d4: `ToolCallMiddlewareProviderOptions` stability improvements and refactoring
- c25f1d4: Apply `noChildNodes: []` to the RXML parser to treat self-closing tags as regular tags; RXML 0.1.1 released (improved parsing stability with inner tags)
- Updated dependencies [c25f1d4]
  - @ai-sdk-tool/rxml@0.1.1

## 2.1.4

### Patch Changes

- 49f5024: Added license to Apache 2.0
- 02b32c0: Morph XML protocol and utils robustness tweaks.

  - Add `RXML` for safer XML extraction (raw string tags, duplicate checks) and use it in `morphXmlProtocol`.
  - Replace relaxed JSON helper with `RJSON`; export `RXML`/`RJSON` from utils.
  - Minor improvements to streaming parsing and XML stringify options.

- 5e03e27: RXML 0.1.0 released (initial Robust XML implementation).

  - Safe XML parsing and streaming
  - JSON Schema-based coercion
  - Stringification
  - Error types
  - Options
  - Examples

  Add RXML docs and README:

  - New comprehensive docs at `docs/rxml.md` and index link
  - Concise package README with install and quick usage

- Updated dependencies [5e03e27]
  - @ai-sdk-tool/rxml@0.1.0

## 2.1.3

### Patch Changes

- 2656b85: Preserve raw inner text for string-typed arguments in Morph-XML protocol; add tests; adjust examples.
  - XML parser now prefers raw inner content for properties typed as string
  - Adds unit tests for parse and streaming cases

## 2.1.2

### Patch Changes

- 6b37de7: Added a debugger to check model output and parsing results.
- 6b37de7: Improved README documentation

## 2.1.1

### Patch Changes

- eb546f2: Add a heuristic-based typecaster to the xml tool parser.
- eb546f2: The XML Parser has been significantly improved through heuristics. It is robust in parallel calls.

## 2.1.0

### Minor Changes

- 86bb361: - To support formats other than the existing json-mix, a protocol standard was created and large-scale refactoring was performed.
  - Added XML parser to increase support for various models including GLM 4.5 model series.

## 2.0.16

### Patch Changes

- bd04904: bump dependencies

## 2.0.15

### Patch Changes

- 43a8d59: bump deps

## 2.0.14

### Patch Changes

- 06582e2: - feat(eval): introduce evaluation toolkit with BFCL and JSON-generation benchmarks; add console/json reporters and `run-test` script; include dataset files. Ensure ESM builds work by fixing relative import extensions, switching to tsup bundling, and aligning TS config.
  - fix(parser): improve `convertToolPrompt()` behavior — preserve assistant tool-call/text order, merge consecutive text blocks, serialize tools as an array of function descriptors (avoids numeric keys), and inject tool system prompt correctly when the first message is system.
  - docs(examples): add/update `examples/eval-core` and `examples/parser-core` (not published).

## 2.0.13

### Patch Changes

- 7358b9f: Add and configure development tooling and quality improvements:

  - add ESLint and Prettier configs
  - add code coverage reporting and CI-friendly setup
  - bump and align dev dependencies

  These changes improve DX, enforce consistent styling, and surface test coverage.

- ca45854: Added extensive testing and improved handling of incomplete function calls.

## 2.0.12

### Patch Changes

- 1ff1177: # feat: upgrade dependencies to latest versions
  - Updated @ai-sdk dependencies to latest versions
  - Resolved zod peer dependency warnings
  - Fixed turbo build warnings
  - Updated test script to indicate no tests are available for core package
  - Removed zod overrides and updated peer dependencies to support multiple versions

## 2.0.11

### Patch Changes

- a7b1878: Fix AI SDK v5 stream protocol compatibility

## 2.0.10

### Patch Changes

- 6354bb8: bump to ai sdk v5

## 2.0.9

### Patch Changes

- 2afa6f2: sync deps beta.3

## 2.0.8

### Patch Changes

- 94e42cc: sync alpha.17

## 2.0.7

### Patch Changes

- 2cd90ae: bump ai package alpha 7

## 2.0.6

### Patch Changes

- 0df0009: Implement tool Choice support for tool selection

## 2.0.5

### Patch Changes

- 64d83bc: bump to ai package alpha-4

## 2.0.4

### Patch Changes

- 1180bcc: bump to ai package alpha-3

## 2.0.3

### Patch Changes

- 34d0e38: Bump to alpha.1

## 2.0.2

### Patch Changes

- a5c0846: Remove unused dependency ai

## 2.0.1

### Patch Changes

- 2d8b8b8: Added reasoning tool call example (deepseek-r1)

## 1.0.2

### Patch Changes

- 21e4f79: update default template

## 1.0.1

### Patch Changes
