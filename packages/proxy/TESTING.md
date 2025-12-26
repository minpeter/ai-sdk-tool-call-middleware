# OpenAI Proxy Server - Testing Guide

This comprehensive test suite ensures the OpenAI Proxy Server works correctly across various scenarios including basic functionality, tool calling, performance, and error handling.

## 🧪 Test Suites (Colocated)

This package uses colocated unit tests next to their respective modules. Current suites:

- Request conversion (OpenAI → AI SDK)
  - `src/openai-request-converter.test.ts`
  - `src/openai-request-converter.normalize.test.ts`
- Result conversion (AI SDK → OpenAI)
  - `src/response-converter.result.test.ts`
- Streaming conversion and state management
  - `src/response-converter.stream.test.ts`
- SSE formatting
  - `src/response-converter.sse.test.ts`

## 🚀 Running Tests

### Quick Start

```bash
# Run unit tests for this package only
pnpm --filter @ai-sdk-tool/proxy test

# Watch mode (pass args through)
pnpm --filter @ai-sdk-tool/proxy vitest -- --watch
```

### Individual Test Suites

```bash
# Basic functionality
pnpm test:basic

# Tool calling
pnpm test:tools

# Performance tests
pnpm test:performance

# Error handling
pnpm test:errors
```

### Comprehensive Testing

```bash
# Run all tests with detailed reporting
pnpm test:all

# Generate coverage report
pnpm test:coverage

# Development mode with verbose output
pnpm test:dev
```

## 📊 SSE Testing

SSE formatting is validated via unit tests using:

- `createOpenAIStreamConverter(model)` to convert AI SDK stream parts
- `createSSEResponse(chunks)` to format Server-Sent Events frames

See `src/response-converter.sse.test.ts`.

## 🎯 Test Configuration

### Vitest Configuration (`vitest.config.ts`)

- Include: `src/**/*.test.ts`
- Exclude: `src/test/**` (legacy), `dist`, `node_modules`
- Environment: Node.js
- Coverage threshold: 70%
- Reporters: Verbose

### Test Ports

Unit tests do not require HTTP ports. For end-to-end (E2E) HTTP testing, use the example app in `examples/proxy-core` (default port `3005`).

## 📋 Test Reports

### Automated Reports

You can generate coverage reports with:

```bash
pnpm --filter @ai-sdk-tool/proxy vitest -- --coverage
```

### Report Contents

- ✅ Pass/fail status for each test
- ⏱️ Execution timing and performance metrics
- 📈 Success rates and coverage statistics
- 🔍 Detailed error information for failures

## 🔧 Development Testing

### Local Development

Unit tests are independent of a running server. For E2E manual tests, start the example server in `examples/proxy-core`.

### Manual Testing with curl

```bash
# Health check
curl http://localhost:3001/health

# Non-streaming completion
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"wrapped-model","messages":[{"role":"user","content":"Hello"}]}'

# Streaming completion
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"wrapped-model","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## 🐛 Debugging Tests

### Common Issues

1. **Port conflicts**: Ensure test ports (3001-3004) are available
2. **Network timeouts**: Increase timeout for slow connections
3. **API keys**: Set `OPENAI_API_KEY` environment variable
4. **Memory issues**: Close unused applications during performance tests

### Debug Mode

```bash
# Run a specific test file with verbose output
pnpm --filter @ai-sdk-tool/proxy vitest -- src/response-converter.stream.test.ts --reporter=verbose
```

### Test Logs

- Individual test logs: `vitest run --reporter=verbose`
- Server logs: Check console output during tests
- Error details: Review generated HTML report

## 📈 Performance Benchmarks

### Expected Performance

- **Response time**: < 5 seconds for simple requests
- **Concurrent handling**: 10+ simultaneous requests
- **Memory usage**: < 50MB peak per request
- **Streaming latency**: < 1 second for first chunk

### Benchmarking

```bash
# Run performance tests
pnpm test:performance

# Generate coverage report
pnpm test:coverage

# View detailed metrics
open test-report.html
```

## 🔒 Security Testing

### Input Validation

- ✅ JSON parsing safety
- ✅ Size limits enforcement
- ✅ Special character handling
- ✅ Unicode support

### Network Security

- ✅ CORS configuration
- ✅ Method validation
- ✅ Header validation
- ✅ Rate limiting behavior

## 🤝 Contributing Tests

### Adding New Tests

1. Place the test next to the module under test (e.g. `src/my-module.test.ts`)
2. Follow naming pattern: `*.test.ts`
3. Use descriptive test names and keep tests focused on single behaviors
4. Include setup/teardown as needed
5. Update this documentation as needed

### Test Structure

```typescript
describe("Test Category", () => {
  beforeAll(async () => {
    // Setup
  });

  afterAll(async () => {
    // Cleanup
  });

  it("should do something specific", async () => {
    // Test implementation
  });
});
```

### Best Practices

- 🎯 Test one behavior per test
- 📝 Use descriptive test names
- 🔄 Cleanup resources in afterAll
- ⏱️ Use appropriate timeouts
- 📊 Include performance assertions where relevant

## 📞 Support

For test-related issues:

1. Check this documentation
2. Review generated test reports
3. Examine console logs
4. Verify environment setup
5. Check network connectivity

---

**Note**: Tests require valid OpenAI API credentials for full functionality. Set the `OPENAI_API_KEY` environment variable before running tests.
