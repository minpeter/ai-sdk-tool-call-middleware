---
"@ai-sdk-tool/parser": patch
---

Refactor codebase to eliminate code duplications and update dependencies

### Code Refactoring

- Extract shared `escapeRegExp` function: removed duplicate from `rxml/heuristics/xml-defaults.ts`, now imports from `core/utils/regex.ts`
- Create shared regex constants: new `core/utils/regex-constants.ts` exports `NAME_CHAR_RE` and `WHITESPACE_REGEX` used by protocol implementations
- Extract shared `ParserOptions` interface: moved to `core/protocols/protocol-interface.ts` from duplicate definitions in `xml-protocol.ts` and `yaml-protocol.ts`
- Create shared protocol utility: new `core/utils/protocol-utils.ts` exports `addTextSegment()` function, replacing duplicate implementations in `json-protocol.ts` and `yaml-protocol.ts`

### Dependency Updates

- Update `@ai-sdk/openai-compatible` from 2.0.26 to 2.0.27
- Update `ai` from 6.0.69 to 6.0.70

These changes improve code maintainability by consolidating ~40 lines of duplicated code into shared utilities, making future changes easier and reducing the risk of inconsistencies.
