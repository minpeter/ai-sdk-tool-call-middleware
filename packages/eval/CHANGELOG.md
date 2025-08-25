# @ai-sdk-tool/eval

## 0.1.0

### Minor Changes

- 06582e2: - feat(eval): introduce evaluation toolkit with BFCL and JSON-generation benchmarks; add console/json reporters and `run-test` script; include dataset files. Ensure ESM builds work by fixing relative import extensions, switching to tsup bundling, and aligning TS config.
  - fix(parser): improve `convertToolPrompt()` behavior — preserve assistant tool-call/text order, merge consecutive text blocks, serialize tools as an array of function descriptors (avoids numeric keys), and inject tool system prompt correctly when the first message is system.
  - docs(examples): add/update `examples/eval-core` and `examples/parser-core` (not published).
