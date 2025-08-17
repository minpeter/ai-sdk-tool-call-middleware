# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

This is a monorepo managed with pnpm workspaces and Turbo. Common development commands:

- `pnpm build` - Build all packages using Turbo
- `pnpm test` - Run tests for all packages using Vitest
- `pnpm dev` - Run development servers for all packages
- `pnpm lint` - Run linting for all packages
- `pnpm check-types` - Run TypeScript type checking for all packages
- `pnpm format` - Format code using Prettier

For package-specific commands, run them from the package directory:

- `cd packages/parser && pnpm test` - Run tests for the parser package only
- `cd packages/parser && pnpm build` - Build the parser package only

## Architecture Overview

This project provides middleware for the AI SDK to enable tool calling functionality on models/providers that don't natively support OpenAI-style tool calling.

### Core Components

**Main Package** (`packages/parser/`):

- `src/index.ts` - Exports pre-configured middleware for Gemma and Hermes formats
- `src/tool-call-middleware.ts` - Core middleware factory that creates tool calling functionality
- `src/stream-handler.ts` - Handles streaming responses and tool call parsing
- `src/utils/` - Utility functions for prompt conversion, JSON parsing, and schema generation

**Key Architecture Patterns**:

1. **Middleware Factory Pattern**: `createToolMiddleware()` creates customizable middleware instances with configurable:
   - Tool call tags (e.g., `<tool_call>`, `\`\`\`tool_call`)
   - System prompt templates for different model formats
   - Response parsing strategies

2. **Streaming Support**: Handles both streaming and non-streaming responses, with special logic for:
   - Tool choice enforcement (`required` or specific tool names)
   - Incremental tool call parsing in streams
   - Content reconstruction with tool calls embedded

3. **Format Support**:
   - **Gemma**: Uses markdown code blocks with `tool_call` language
   - **Hermes**: Uses XML-style `<tool_call>` tags
   - Extensible to support additional formats

### Tool Call Processing Flow

1. **Parameter Transformation**: Converts AI SDK tool definitions into model-specific prompts
2. **Response Parsing**: Extracts tool calls from text using format-specific patterns
3. **Content Reconstruction**: Converts parsed tool calls back to AI SDK format
4. **Schema Validation**: Enforces tool choice constraints via JSON schema when needed

### Examples Directory

The `examples/core/` directory contains comprehensive usage examples:

- Basic tool calling (streaming and non-streaming)
- Tool choice scenarios (required, specific tool selection)
- Reasoning with tool calls

## Package Management

- Uses pnpm workspaces with packages in `packages/` and `examples/`
- Managed with Changesets for versioning and publishing
- Main package publishes as `@ai-sdk-tool/parser` to npm

## Testing

Tests use Vitest and focus on:

- Stream protocol compliance
- Tool call parsing accuracy
- Edge cases in JSON parsing and content reconstruction

## TypeScript & Type Safety

This project uses TypeScript, and maintaining strict type safety is crucial. All code must be fully typesafe:

- **No `any` types**: Always provide explicit types or let TypeScript infer them
- **Strict mode**: The project uses TypeScript strict mode - no implicit any, strict null checks
- **Test code type safety**: Test files must also be fully typesafe with proper type annotations
- **Type assertions**: Use type assertions sparingly and only when necessary
- **Generic types**: Properly type generic functions and classes
