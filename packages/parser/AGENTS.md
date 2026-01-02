# packages/parser

Core tool-call parsing middleware for AI SDK v5.

## STRUCTURE

```
src/
├── core/
│   ├── protocols/     # Protocol implementations
│   ├── heuristics/    # XML repair pipeline
│   ├── utils/         # Shared utilities
│   └── types.ts       # Core type definitions
├── v5/                # AI SDK v4 (LanguageModelV1) - legacy
├── v6/                # AI SDK v5 (LanguageModelV3) - default
├── community/         # Community-contributed protocols
└── __tests__/
    ├── protocols/     # Protocol-specific tests
    ├── heuristics/    # Heuristic tests
    ├── utils/         # Utility tests
    └── e2e/           # End-to-end tests
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add new protocol | `core/protocols/` - implement `ToolCallProtocol` |
| Modify streaming | `v6/stream-handler.ts` |
| Modify batch mode | `v6/generate-handler.ts` |
| Add heuristic | `core/heuristics/xml-defaults.ts` |
| Fix XML parsing | Check heuristics first, then protocol |

## PROTOCOL INTERFACE

```typescript
interface ToolCallProtocol {
  formatTools(...)      // Tools -> system prompt text
  formatToolCall(...)   // ToolCall -> conversation format
  formatToolResponse(...)  // Result -> conversation format
  parseGeneratedText(...) // Text -> ContentPart[] with tool calls
  createStreamParser(...)  // TransformStream for streaming
  extractToolCallSegments?(...)  // Optional: extract raw segments
}
```

## PREBUILT MIDDLEWARES

| Export | Protocol | Use Case |
|--------|----------|----------|
| `gemmaToolMiddleware` | jsonMixProtocol | Gemma, JSON in markdown fences |
| `hermesToolMiddleware` | jsonMixProtocol | Hermes, `<tool_call>` wrapped JSON |
| `morphXmlToolMiddleware` | morphXmlProtocol | GLM, plain XML elements |

## HEURISTICS PIPELINE

Order matters. Applied before parsing:

1. `escapeInvalidLtHeuristic` - Escape stray `<` in content
2. `dedupeShellStringTagsHeuristic` - Remove duplicate tags
3. `normalizeCloseTagsHeuristic` - Fix `< /tag>` -> `</tag>`
4. `balanceTagsHeuristic` - Add missing close tags
5. `repairAgainstSchemaHeuristic` - Fix based on tool schema

## DEBUG

```bash
# Log raw/parsed chunks
DEBUG_PARSER_MW=stream pnpm test

# Log matched text and parsed summary
DEBUG_PARSER_MW=parse pnpm test

# Change highlight style
DEBUG_PARSER_MW_STYLE=bg|inverse|underline|bold
```

## CONVENTIONS

- Protocol factories `() => Protocol` for per-request state isolation
- `TCMCore*` prefixed types = version-agnostic core types
- `providerOptions.toolCallMiddleware.originalTools` propagates tool schemas internally
- Test naming: `{feature}.{scenario}.test.ts`

## ANTI-PATTERNS

- **NEVER** parse XML without running heuristics first (malformed LLM output)
- **NEVER** assume well-formed JSON from LLM (use `robustJsonParse`)
- **NEVER** block streaming on full text accumulation

## TESTS

```bash
pnpm test              # All tests
pnpm test:watch        # Watch mode
pnpm test -- -t "xml"  # Filter by name
```

85 test files. Focus areas:
- `protocols/*.test.ts` - Protocol edge cases
- `heuristics/*.test.ts` - XML repair
- `stream-handler.*.test.ts` - Streaming compliance
