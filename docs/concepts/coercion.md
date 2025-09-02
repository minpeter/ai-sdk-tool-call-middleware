# [dev] Argument Coercion

The middleware coerces `tool-call.input` to match the tool JSON Schema so tools receive correct types (numbers, booleans, arrays/objects) even when models emit strings or XML-like shapes.

## Where it runs

- Generate mode:
  - After `parseGeneratedText`, each `tool-call` passes through `fixToolCallWithSchema` (schema-based coercion, then `input` is `JSON.stringify`-ed).
- Stream mode:
  - Protocol-dependent. The XML protocol coerces during both `parseGeneratedText` and `createStreamParser`. The JSON-mix protocol does not coerce in stream (only generate’s global pass applies).
- Tool-choice mode (provider-native):
  - Coercion is skipped. The model-provided arguments are forwarded as-is.

## Schema selection

- XML protocol prefers provider-original schemas when available:
  - `providerOptions.toolCallMiddleware.originalToolSchemas` (internal plumbing) → best fidelity.
  - Fallback to the transformed `inputSchema` passed to the provider.

## Coercion rules (coercion.ts)

- Unwrap schema: `{ jsonSchema: ... }` is unwrapped recursively.
- Type detection (`getSchemaType`): resolves to `object`/`array` even when `type` is omitted (via `properties`, `items`, `prefixItems`).
- Strings:
  - Parse booleans (`"true"|"false"`) and numbers (int/float/scientific).
  - JSON-like strings parsed even when schema is absent.
  - For `object`/`array` schemas, normalize and parse strings (single quotes → double quotes; handle empty `{}`).
- Objects (value is object or object-like string):
  - Recursively coerce properties using their schemas; unknown properties are preserved.
- Arrays:
  - Respect `prefixItems` (tuples) and `items`. If length equals `prefixItems.length`, coerce per index; otherwise use `items`.
  - If a string fails JSON parse, fall back to CSV or newline splitting; trim and coerce each element.
  - XML-aware shapes:
    - `{ item: [...] }` → `[...]`
    - Objects with all numeric keys (e.g., `{ "0": ..., "1": ... }`) → tuple/array (sorted by index)
    - Single-key objects whose value is an array → that array
  - If schema is `array` and value is scalar/null/boolean, wrap into a single-element array and coerce the element.

## Helpers

- `coerceBySchema(value, schema)` — main coercion routine.
- `fixToolCallWithSchema(part, tools)` — applies `coerceBySchema` using the matched tool’s `inputSchema`, then serializes `input` as JSON.

See `packages/parser/src/utils/coercion.ts`.

## Tips

- For streaming XML, set `providerOptions.toolCallMiddleware.originalToolSchemas` so the stream parser can coerce with the provider’s unmodified schemas.
- If your provider uses tool-choice, ensure the model arguments are already schema-conformant (coercion is not run in that path).

## Quick examples

- number schema + value `"42"` → `42`
- `array<number>` schema + value `"1, 2, 3"` → `[1, 2, 3]`
- object schema `{ a: number, b: boolean }` + value `'{"a":"1","b":"true"}'` → `{ a: 1, b: true }`
