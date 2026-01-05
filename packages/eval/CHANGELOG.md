# @ai-sdk-tool/eval

## 1.1.0

### Minor Changes

- 720f9df: Add BFCL v4 multi-turn benchmark with pure TypeScript implementation (no Python dependency)
- b9b13bd: Remove gemma support and rename middleware functions

  - Remove gemmaToolMiddleware and related code
  - Rename morphXmlToolMiddleware to xmlToolMiddleware
  - Rename orchestratorToolMiddleware to ymlToolMiddleware
  - Update all imports, exports, and documentation

### Patch Changes

- b9b13bd: Improve benchmark report formatting by converting ASCII tables to native Markdown tables for better rendering in PR comments, and fix comment matching consistency.
- b9b13bd: feat: Implement PR #141 review feedback - clean up gemma support and fix documentation

  - Remove all gemma model references and configurations across codebase
  - Fix broken README examples by adding proper model and middleware imports
  - Change xmlToolMiddleware placement from "first" to "last" for consistency
  - Fix yamlToolMiddleware import name in benchmark scripts
  - Update ai dependency from 6.0.5 to 6.0.6
  - Add missing transformParams to disk cache middleware

- Updated dependencies [b9b13bd]
  - @ai-sdk-tool/middleware@0.0.2

## 1.0.0

### Major Changes

- 537adc6: bump ai v6 (middleware v3 not yet)

### Patch Changes

- 537adc6: minor dependency version bump
- Updated dependencies [537adc6]
  - @ai-sdk-tool/middleware@0.0.1

## 1.0.0-canary.1

### Patch Changes

- 1f36102: minor dependency version bump

## 1.0.0-canary.0

### Major Changes

- df62ec5: bump ai v6 (middleware v3 not yet)

## 0.1.8

### Patch Changes

- dce31fe: Improved debugging capabilities of console.debug.

## 0.1.7

### Patch Changes

- c25f1d4: Added maxToken option to enable

## 0.1.6

### Patch Changes

- 49f5024: Added license to Apache 2.0

## 0.1.5

### Patch Changes

- 2656b85: Added option to control temperature parameter.

## 0.1.4

### Patch Changes

- 6b37de7: Improved README documentation

## 0.1.3

### Patch Changes

- eb546f2: Fixed an issue where the expected and actual values ​​would not be mapped even though they matched in certain corner tests.

## 0.1.2

### Patch Changes

- bd04904: bump dependencies
- bd04904: toolChoice required -> auto

## 0.1.1

### Patch Changes

- 43a8d59: Fix publish configuration to ensure public access for the package
- 43a8d59: bump deps

## 0.1.0

### Minor Changes

- 06582e2: - feat(eval): introduce evaluation toolkit with BFCL and JSON-generation benchmarks; add console/json reporters and `run-test` script; include dataset files. Ensure ESM builds work by fixing relative import extensions, switching to tsup bundling, and aligning TS config.
