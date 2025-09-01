# `@ai-sdk-tool/` documentation

Monorepo documentation for AI SDK tool-calling middleware and evaluation utilities.

- Getting Started: [getting-started.md](getting-started.md)
- Prebuilt Middlewares (choose one):
  - **gemmaToolMiddleware**: JSON tool calls in markdown fences — Gemma-like models
  - **hermesToolMiddleware**: JSON payload wrapped in XML tags — Hermes/Llama-style
  - **xmlToolMiddleware**: XML elements per tool — GLM/XML-friendly models
- Guides
  - [dev] Tool Calling: [guides/tool-calling.md](guides/tool-calling.md)
  - [dev] Handlers Overview: [guides/handlers.md](guides/handlers.md)
  - [dev] Tool Choice: [guides/tool-choice.md](guides/tool-choice.md)
  - [dev] Debugging: [guides/debugging.md](guides/debugging.md)
- Concepts
  - [dev] Protocols: [concepts/protocols.md](concepts/protocols.md)
  - [dev] Middleware Architecture: [concepts/middleware.md](concepts/middleware.md)
  - [dev] Argument Coercion: [concepts/coercion.md](concepts/coercion.md)
  - [dev] Streaming Algorithms: [concepts/streaming.md](concepts/streaming.md)
  - [dev] Provider Options: [concepts/provider-options.md](concepts/provider-options.md)
- Packages
  - **RXML (Robust XML)**: Robust XML parser/streamer/builder — [rxml.md](rxml.md)
- Evaluation: [evaluation.md](evaluation.md)
- Examples: [examples.md](examples.md)

## License

This repository is licensed under Apache License 2.0. See the root `LICENSE` for details. Include the `NOTICE` file in distributions per the license.
