# @ai-sdk-tool/parser

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

- 780b01c: Fix gemma streaming matching issue
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

- 2bc7fd4: Initial version released (gemma, hermes)
