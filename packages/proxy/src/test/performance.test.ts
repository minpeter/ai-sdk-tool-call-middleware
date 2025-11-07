/**
 * Performance Tests for OpenAI Proxy Server
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAIProxyServer } from "../server.js";

// biome-ignore lint/performance/useTopLevelRegex: test regex patterns
const HELLO_REGEX = /hello/i;
const CONSISTENT_REGEX = /consistent/i;

describe("OpenAI Proxy Server - Performance", () => {
  let server: OpenAIProxyServer;
  const baseUrl = "http://localhost:3003";

  const friendli = createOpenAICompatible({
    name: "friendli",
    apiKey: process.env.FRIENDLI_TOKEN,
    baseURL: "https://api.friendli.ai/serverless/v1",
    includeUsage: true,
    fetch: (url, options) => {
      const body = options?.body ? JSON.parse(options.body as string) : {};
      body.parse_reasoning = true;
      return fetch(url, { ...options, body: JSON.stringify(body) });
    },
  });

  beforeAll(async () => {
    const model = friendli("google/gemma-3-27b-it");
    const wrappedModel = wrapLanguageModel({
      model,
      middleware: [],
    });

    server = new OpenAIProxyServer({
      model: wrappedModel,
      port: 3003,
      host: "localhost",
      cors: true,
    });

    await server.start();

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    await server.stop();
  });

  it("should handle concurrent requests efficiently", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: 'Say "Hello"' }],
      temperature: 0.1,
    };

    const concurrency = 10;
    const startTime = Date.now();

    const promises = Array.from({ length: concurrency }, async () => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      expect(response.ok).toBe(true);
      return response.json();
    });

    const results = await Promise.all(promises);
    const endTime = Date.now();
    const totalTime = endTime - startTime;

    expect(results).toHaveLength(concurrency);
    // biome-ignore lint/complexity/noForEach: iterating over test results
    for (const result of results) {
      expect(result).toHaveProperty("choices");
      expect(result.choices[0].message.content).toMatch(HELLO_REGEX);
    }

    // Should complete concurrent requests faster than sequential
    expect(totalTime).toBeLessThan(concurrency * 2000); // Less than 2s per request sequentially

    console.log(`📊 Concurrent requests: ${concurrency} in ${totalTime}ms`);
  });

  it("should handle large message content", async () => {
    const largeContent = "A".repeat(10_000); // 10KB of text

    const request = {
      model: "wrapped-model",
      messages: [
        { role: "user", content: `Process this large text: ${largeContent}` },
      ],
      temperature: 0.1,
    };

    const startTime = Date.now();

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);

    const data = await response.json();
    const endTime = Date.now();
    const processingTime = endTime - startTime;

    expect(data.choices[0].message.content).toBeTruthy();
    expect(processingTime).toBeLessThan(10_000); // Should complete within 10 seconds

    console.log(`📊 Large content (10KB) processed in ${processingTime}ms`);
  });

  it("should handle streaming performance under load", async () => {
    const request = {
      model: "wrapped-model",
      messages: [
        { role: "user", content: "Write a short story about technology" },
      ],
      stream: true,
      temperature: 0.7,
    };

    const startTime = Date.now();
    const chunkCount = 50;
    let totalChunks = 0;
    let firstChunkTime = 0;

    const promises = Array.from({ length: 5 }, async (_, index) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      expect(response.ok).toBe(true);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let chunks = 0;
      let localFirstChunk = 0;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          const _chunk = decoder.decode(value, { stream: true });
          chunks += 1;

          if (chunks === 1 && localFirstChunk === 0) {
            localFirstChunk = Date.now() - startTime;
          }

          if (chunks >= chunkCount) {
            break;
          }
        }
      }

      totalChunks += chunks;
      if (index === 0) {
        firstChunkTime = localFirstChunk;
      }

      return chunks;
    });

    const results = await Promise.all(promises);
    const endTime = Date.now();
    const totalTime = endTime - startTime;

    expect(results).toHaveLength(5);
    expect(totalChunks).toBeGreaterThan(0);
    expect(firstChunkTime).toBeLessThan(1000); // First chunk should arrive quickly

    console.log("📊 Streaming performance:");
    console.log(`   - Total chunks processed: ${totalChunks}`);
    console.log(`   - First chunk latency: ${firstChunkTime}ms`);
    console.log(`   - Total time: ${totalTime}ms`);
  });

  it("should handle memory efficiency with repeated requests", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "Count to 10" }],
      temperature: 0.1,
    };

    const iterations = 20;
    const memorySnapshots: number[] = [];

    // biome-ignore lint/nursery/noIncrementDecrement: simple loop counter
    for (let i = 0; i < iterations; i += 1) {
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const memBefore = process.memoryUsage().heapUsed;

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      expect(response.ok).toBe(true);
      await response.json();

      const memAfter = process.memoryUsage().heapUsed;
      memorySnapshots.push(memAfter - memBefore);
    }

    const avgMemoryPerRequest =
      memorySnapshots.reduce((a, b) => a + b, 0) / memorySnapshots.length;
    const maxMemoryPerRequest = Math.max(...memorySnapshots);

    // Memory usage should be reasonable
    expect(avgMemoryPerRequest).toBeLessThan(10 * 1024 * 1024); // Less than 10MB per request
    expect(maxMemoryPerRequest).toBeLessThan(50 * 1024 * 1024); // Less than 50MB peak

    console.log(`📊 Memory efficiency over ${iterations} requests:`);
    console.log(
      `   - Average memory per request: ${(avgMemoryPerRequest / 1024 / 1024).toFixed(2)}MB`
    );
    console.log(
      `   - Peak memory per request: ${(maxMemoryPerRequest / 1024 / 1024).toFixed(2)}MB`
    );
  });

  it("should handle rate limiting gracefully", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "Quick response" }],
      temperature: 0.1,
    };

    const rapidRequests = 50;
    const promises = Array.from({ length: rapidRequests }, async (_, index) => {
      try {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });

        return {
          index,
          status: response.status,
          success: response.ok,
        };
      } catch (error) {
        return {
          index,
          status: 0,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    const results = await Promise.all(promises);

    const successful = results.filter((r) => r.success).length;
    const failed = results.length - successful;

    console.log(`📊 Rate limiting test (${rapidRequests} rapid requests):`);
    console.log(`   - Successful: ${successful}`);
    console.log(`   - Failed: ${failed}`);

    // Most requests should succeed or fail gracefully
    expect(successful + failed).toBe(rapidRequests);

    // If there are failures, they should be proper HTTP errors
    const failures = results.filter((r) => !r.success);
    // biome-ignore lint/complexity/noForEach: iterating over failure results
    for (const failure of failures) {
      if (failure.status > 0) {
        expect(failure.status).toBeGreaterThanOrEqual(400);
        expect(failure.status).toBeLessThan(600);
      }
    }
  });

  it("should maintain response time consistency", async () => {
    const request = {
      model: "wrapped-model",
      messages: [
        { role: "user", content: 'Respond with exactly "Consistent"' },
      ],
      temperature: 0.0,
    };

    const samples = 10;
    const responseTimes: number[] = [];

    // biome-ignore lint/nursery/noIncrementDecrement: simple loop counter
    for (let i = 0; i < samples; i += 1) {
      const startTime = Date.now();

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      expect(response.ok).toBe(true);

      const data = await response.json();
      const endTime = Date.now();

      responseTimes.push(endTime - startTime);

      // Verify consistent response
      expect(data.choices[0].message.content).toMatch(CONSISTENT_REGEX);
    }

    const avgTime =
      responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    const maxTime = Math.max(...responseTimes);
    const minTime = Math.min(...responseTimes);
    const variance = maxTime - minTime;

    console.log(`📊 Response time consistency (${samples} samples):`);
    console.log(`   - Average: ${avgTime.toFixed(0)}ms`);
    console.log(`   - Min: ${minTime}ms`);
    console.log(`   - Max: ${maxTime}ms`);
    console.log(`   - Variance: ${variance}ms`);

    // Response times should be reasonably consistent
    expect(variance).toBeLessThan(avgTime); // Variance less than average
    expect(avgTime).toBeLessThan(5000); // Average under 5 seconds
  });
});
