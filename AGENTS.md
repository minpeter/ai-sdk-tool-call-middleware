# AGENTS.md

This file provides guidance for agents and code assistants (such as Claude Code, Codex, and others) when working with code in this repository.

## Development Commands

This is a monorepo managed by pnpm workspaces and Turborepo:

- `pnpm build` - Build all packages in parallel
- `pnpm test` - Run all tests in parallel
- `pnpm dev` - Start development mode (watch builds)
- `pnpm lint` - Lint all packages
- `pnpm lint:fix` - Fix linting issues and format code
- `pnpm fmt` - Check code formatting
- `pnpm fmt:fix` - Fix formatting and linting issues
- `pnpm typecheck` - Type-check all packages

For single package development, run commands from within the package directory:

- `cd packages/parser && pnpm test:watch` - Watch tests for parser package only
- `cd packages/eval && pnpm dev` - Develop eval package only

## Architecture Overview

This project provides middleware for AI SDK to enable tool calling with models that don't natively support OpenAI-style tool calling.

### Core Packages

**@ai-sdk-tool/parser** (`packages/parser/`):

- Main middleware package for tool call parsing
- Exports pre-configured middlewares: `gemmaToolMiddleware`, `hermesToolMiddleware`, `morphXmlToolMiddleware`
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

**Middleware Pattern**: Uses AI SDK middleware to intercept and transform:

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


# Ultracite Code Standards

This project uses **Ultracite**, a zero-config Biome preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `pnpm dlx ultracite fix`
- **Check for issues**: `pnpm dlx ultracite check`
- **Diagnose setup**: `pnpm dlx ultracite doctor`

Biome (the underlying engine) provides extremely fast Rust-based linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `pnpm dlx ultracite fix` before committing to ensure compliance.
