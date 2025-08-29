# AGENTS.md

This file provides guidance for agents and code assistants (such as Claude Code, Codex, and others) when working with code in this repository.

## Development Commands

This is a monorepo managed by pnpm workspaces and Turborepo:

- `pnpm build` - Build all packages in parallel
- `pnpm test` - Run all tests in parallel
- `pnpm test:watch` - Run tests in watch mode
- `pnpm dev` - Start development mode (watch builds)
- `pnpm lint` - Lint all packages
- `pnpm lint:fix` - Fix linting issues and format code
- `pnpm fmt` - Check code formatting
- `pnpm fmt:fix` - Fix formatting and linting issues
- `pnpm check-types` - Type-check all packages

For single package development, run commands from within the package directory:

- `cd packages/parser && pnpm test:watch` - Watch tests for parser package only
- `cd packages/eval && pnpm dev` - Develop eval package only

## Architecture Overview

This project provides middleware for AI SDK v2 to enable tool calling with models that don't natively support OpenAI-style tool calling.

### Core Packages

**@ai-sdk-tool/parser** (`packages/parser/`):

- Main middleware package for tool call parsing
- Exports pre-configured middlewares: `gemmaToolMiddleware`, `hermesToolMiddleware`, `xmlToolMiddleware`
- Core factory function: `createToolMiddleware()` for custom protocols
- Protocol system with pluggable parsers for different model formats (JSON-mix, XML, etc.)

**@ai-sdk-tool/eval** (`packages/eval/`):

- Benchmarking and evaluation tools
- BFCL (Berkeley Function Calling Leaderboard) benchmark implementations
- JSON generation benchmarks
- Custom benchmark creation utilities

### Key Architecture Patterns

**Protocol-Based Design**: The `ToolCallProtocol` interface defines how tools are:

- Formatted for the model (`formatTools`, `formatToolCall`, `formatToolResponse`)
- Parsed from model output (`parseGeneratedText`, `createStreamParser`)

**Middleware Pattern**: Uses AI SDK v2 middleware to intercept and transform:

- `transformParams`: Converts tool definitions to system prompts
- `wrapStream`: Handles streaming responses with tool call detection
- `wrapGenerate`: Handles non-streaming responses

**Handler Architecture**:

- `stream-handler.ts`: Manages streaming tool call detection and parsing
- `generate-handler.ts`: Handles batch/generate mode tool calls
- `transform-handler.ts`: Transforms AI SDK parameters for provider compatibility

### Protocol Implementations

Located in `packages/parser/src/protocols/`:

- `json-mix-protocol.ts`: Handles JSON tool calls within markdown code fences
- `morph-xml-protocol.ts`: XML-based tool calling format
- `dummy-protocol.ts`: Testing/fallback protocol

## Testing Strategy

Tests use Vitest and are organized by:

- Unit tests in `tests/` directories
- Protocol-specific edge case testing
- Stream handling compliance tests
- E2E examples in `scripts/` directories

Run `pnpm test` from root or `pnpm test:watch` from individual package directories.
