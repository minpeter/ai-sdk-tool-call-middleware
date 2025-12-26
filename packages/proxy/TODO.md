# TODO

## 1. Align proxy documentation and example ports

- **Background:** The proxy example server now runs on port `3005` and uses `hermesToolMiddleware`, but various README snippets still reference `3000` and older middleware names. This inconsistency can mislead readers when following curl examples.
- **Action:** Update `examples/proxy-core/README.md` to consistently reference port `3005`, surface the default port near the top, and mention `hermesToolMiddleware` explicitly in setup instructions.
- **Owner/Priority:** Documentation · High

## 2. Add migration notes for refactored converters

- **Background:** `converters.ts` was split into `openai-request-converter.ts` and `response-utils.ts`, and tool definitions now require `inputSchema` instead of `parameters`. Developers upgrading from earlier versions need guidance.
- **Action:** Create a "Migration" section in `packages/proxy/README.md` summarizing file moves, API changes, and the new colocated testing layout.
- **Owner/Priority:** Documentation · Medium

## 3. Expand end-to-end streaming validation

- **Background:** Unit tests now cover multi tool-call deltas and finish-only or finish-step-only cases, but there is no full HTTP streaming test that boots the proxy and inspects SSE output.
- **Action:** Add an E2E test (e.g., in `examples/proxy-core`) that starts the proxy server, performs a streamed request, and validates SSE frames end-to-end.
- **Owner/Priority:** Testing · Medium

## 4. Provide structured logging helper and guidance

- **Background:** The proxy accepts a `logger`, yet there is no documentation or helper for structured logging with level control.
- **Action:** Supply a lightweight logger utility (or documentation snippet) demonstrating JSON-formatted logs with level filtering, and show how to inject it via `ProxyConfig`.
- **Owner/Priority:** Core/Docs · Medium

## 5. Document tool merging semantics with examples

- **Background:** Server-side tools override request-provided tools, but this precedence is only briefly noted.
- **Action:** Expand README notes with concrete examples demonstrating how request tools and server tools merge, including override scenarios.
- **Owner/Priority:** Documentation · Low

## 6. Showcase @ai-sdk-tool/middleware usage in examples

- **Background:** A new reusable middleware package (`@ai-sdk-tool/middleware`) has been introduced, yet examples do not highlight how to combine it with tool middleware.
- **Action:** Add a section to the examples (e.g., proxy-core or parser-core) illustrating how to compose `reasoning-parser` middleware with tool support.
- **Owner/Priority:** Examples · Medium

## 7. Reintroduce lightweight performance smoke tests

- **Background:** Earlier documentation referenced performance tests, but the current test suite no longer exercises throughput or latency characteristics.
- **Action:** Provide an optional benchmark script that measures streaming latency and chunk throughput, ensuring regressions are detectable.
- **Owner/Priority:** Testing · Low
