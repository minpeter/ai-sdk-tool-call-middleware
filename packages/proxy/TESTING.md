# OpenAI Proxy Server - Testing Guide

This comprehensive test suite ensures the OpenAI Proxy Server works correctly across various scenarios including basic functionality, tool calling, performance, and error handling.

## 🧪 Test Suites

### 1. Basic Functionality Tests (`basic-functionality.test.ts`)
Tests core API functionality and OpenAI compatibility:

- ✅ Health check endpoint
- ✅ Models listing endpoint  
- ✅ Non-streaming chat completions
- ✅ Streaming chat completions with SSE
- ✅ Request validation (missing messages, empty arrays)
- ✅ Invalid JSON handling
- ✅ CORS preflight requests

### 2. Tool Calling Tests (`tool-calling.test.ts`)
Tests dynamic tool calling capabilities:

- ✅ Tool calls in non-streaming mode
- ✅ Multiple tool calls
- ✅ Tool calls in streaming mode
- ✅ Tool result message handling
- ✅ Invalid tool schema handling
- ✅ Empty tools array handling

### 3. Performance Tests (`performance.test.ts`)
Tests performance under various conditions:

- ✅ Concurrent request handling
- ✅ Large message content processing
- ✅ Streaming performance under load
- ✅ Memory efficiency with repeated requests
- ✅ Rate limiting behavior
- ✅ Response time consistency

### 4. Error Handling Tests (`error-handling.test.ts`)
Tests robustness and edge cases:

- ✅ Malformed JSON handling
- ✅ Extremely large requests
- ✅ Invalid model names and parameters
- ✅ Invalid message roles and content
- ✅ Invalid tool definitions
- ✅ Connection interruption handling
- ✅ Special characters and Unicode content
- ✅ HTTP method validation
- ✅ Server overload simulation

## 🚀 Running Tests

### Quick Start
```bash
# Install dependencies
pnpm install

# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run with UI interface
pnpm test:ui
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

## 📊 SSE Chunk Inspector

The `SSEChunkInspector` class provides detailed analysis of Server-Sent Events:

```typescript
import { SSEChunkInspector, testSSEStreaming } from './src/test/sse-chunk-inspector.js';

// Create inspector
const inspector = new SSEChunkInspector();

// Test streaming
await testSSEStreaming('http://localhost:3001/v1/chat/completions', request, inspector);

// Get detailed analysis
const report = inspector.getAnalysisReport();
console.log(report);
```

### Features
- 📈 Real-time chunk parsing and analysis
- 📝 Text content reconstruction
- 🔧 Tool call detection and tracking
- ⏱️ Timeline analysis with timestamps
- 📊 Comprehensive reporting

## 🎯 Test Configuration

### Vitest Configuration (`vitest.config.ts`)
- **Environment**: Node.js
- **Timeout**: 30 seconds (network tests)
- **Coverage**: 70% threshold
- **Concurrency**: Enabled (max 4 threads)
- **Reporters**: Verbose output

### Test Ports
Tests use different ports to avoid conflicts:
- Basic functionality: `3001`
- Tool calling: `3002`
- Performance: `3003`
- Error handling: `3004`

## 📋 Test Reports

### Automated Reports
Running `pnpm test:all` generates:
- 📄 `test-report.json` - Detailed JSON report
- 🌐 `test-report.html` - Interactive HTML report
- 📊 Console summary with metrics

### Report Contents
- ✅ Pass/fail status for each test
- ⏱️ Execution timing and performance metrics
- 📈 Success rates and coverage statistics
- 🔍 Detailed error information for failures

## 🔧 Development Testing

### Local Development
```bash
# Start development server
pnpm dev

# Run tests against development server
pnpm test:dev
```

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
# Run with verbose output
pnpm test:basic --reporter=verbose

# Run specific test in debug mode
npx vitest run src/test/basic-functionality.test.ts --no-coverage --reporter=verbose
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
1. Create test file in `src/test/`
2. Follow naming pattern: `*.test.ts`
3. Use descriptive test names
4. Include setup/teardown as needed
5. Update this documentation

### Test Structure
```typescript
describe('Test Category', () => {
  beforeAll(async () => {
    // Setup
  });

  afterAll(async () => {
    // Cleanup
  });

  it('should do something specific', async () => {
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
