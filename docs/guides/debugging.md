# [dev] Debugging

Enable middleware debug logs via environment variables.

## Levels

- `DEBUG_PARSER_MW=off` (default): no logs
- `DEBUG_PARSER_MW=stream`: logs raw provider output and the normalized parts the middleware emits
- `DEBUG_PARSER_MW=parse`: after parsing completes, logs a highlighted view of detected tool-call source text (origin) and a JSON summary of tool-calls

Aliases:

- `DEBUG_PARSER_MW=1`, `true`, `yes` → treated as `stream`
- `DEBUG_PARSER_MW=2` → treated as `parse`

When it logs:

- `stream`:
  - Streaming: `[debug:mw:raw]` per provider part, `[debug:mw:out]` per normalized part
  - Generate: `[debug:mw:raw]` before parse, then `[debug:mw:out]`
- `parse`:
  - Streaming: on finish → `[debug:mw:origin]`, `[debug:mw:summary]`
  - Generate: after parse → `[debug:mw:origin]`, `[debug:mw:summary]`
  - ToolChoice: generate logs raw once + summary; stream logs summary

## Styles (parse summary)

- `DEBUG_PARSER_MW_STYLE=bg` (default), `inverse` (or `invert`), `underline` (or `ul`), `bold`
- Truthy values (e.g., `1`, `true`, `yes`) map to `bg`
- Origin lines are highlighted using the selected style; the summary is printed with a distinct background for readability.

## Outputs (tags)

- `[debug:mw:raw]` — provider output (string text or stream parts)
- `[debug:mw:out]` — normalized parts emitted by the middleware
- `[debug:mw:origin]` — highlighted source segments recognized as tool-calls
- `[debug:mw:summary]` — JSON summary of emitted tool-calls

## Structured capture (no console spam)

When integrating with evaluators or apps, prefer a structured capture instead of console logs:

- Provide `providerOptions.toolCallMiddleware.debugSummary` to capture parse results.
- The middleware populates this JSON-safe object and suppresses console output in `parse` mode.

Shape:

```ts
{
  debugSummary?: {
    originalText?: string;        // pre-parse origin segments (per protocol)
    toolCalls?: string;           // JSON stringified array of { toolName?: string; input?: unknown }
  }
}
```

Usage:

```ts
const debugSummary: { originalText?: string; toolCalls?: string } = {};
const { text, toolCalls } = await generateText({
  model,
  messages,
  tools,
  providerOptions: {
    toolCallMiddleware: {
      debugSummary,
    },
  },
});

// Later, read structured info for reporting:
console.log(debugSummary.originalText);
console.log(JSON.parse(debugSummary.toolCalls ?? "[]"));
```

## How to use

- macOS/Linux (one-off):
  - `DEBUG_PARSER_MW=stream node your-app.js`
  - `DEBUG_PARSER_MW=parse node your-app.js`
- With pnpm scripts: `DEBUG_PARSER_MW=parse pnpm dev`
- Numeric/boolean shorthands:
  - `DEBUG_PARSER_MW=1` → stream, `DEBUG_PARSER_MW=2` → parse

Notes:

- Variable name is intentionally `DEBUG_PARSER_MW` (no extra “R”).
- ANSI colors render best in TTY; collectors may strip styling.
- Origin highlighting uses each protocol’s optional `extractToolCallSegments`.
