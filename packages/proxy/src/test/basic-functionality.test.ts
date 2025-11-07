/**
 * Basic Functionality Tests for OpenAI Proxy Server
 */

import { openai } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAIProxyServer } from "../server.js";
import { SSEChunkInspector } from "./sse-chunk-inspector.js";

// biome-ignore lint/performance/useTopLevelRegex: test regex patterns
const COUNT_REGEX = /1.*2.*3.*4.*5/;
const HELLO_WORLD_REGEX = /hello world/i;

describe("OpenAI Proxy Server - Basic Functionality", () => {
  let server: OpenAIProxyServer;
  const baseUrl = "http://localhost:3001";

  beforeAll(async () => {
    // Create wrapped model for testing
    const model = openai("gpt-3.5-turbo");
    const wrappedModel = wrapLanguageModel({
      model,
      middleware: [], // No middleware for basic tests
    });

    server = new OpenAIProxyServer({
      model: wrappedModel,
      port: 3001,
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

  it("should respond to health check", async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data).toHaveProperty("status", "ok");
    expect(data).toHaveProperty("timestamp");
  });

  it("should list available models", async () => {
    const response = await fetch(`${baseUrl}/v1/models`);

    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data).toHaveProperty("object", "list");
    expect(data).toHaveProperty("data");
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data).toHaveLength(1);
    expect(data.data[0]).toHaveProperty("id", "wrapped-model");
  });

  it("should handle non-streaming chat completion", async () => {
    const request = {
      model: "wrapped-model",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: 'Say "Hello World"' },
      ],
      temperature: 0.7,
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data).toHaveProperty("object", "chat.completion");
    expect(data).toHaveProperty("model", "wrapped-model");
    expect(data).toHaveProperty("choices");
    expect(Array.isArray(data.choices)).toBe(true);
    expect(data.choices[0]).toHaveProperty("message");
    expect(data.choices[0].message).toHaveProperty("content");
    expect(data.choices[0].message).toHaveProperty("role", "assistant");

    // Should contain "Hello World"
    expect(data.choices[0].message.content).toMatch(HELLO_WORLD_REGEX);
  });

  it("should handle streaming chat completion", async () => {
    const request = {
      model: "wrapped-model",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Count from 1 to 5" },
      ],
      stream: true,
      temperature: 0.1,
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const inspector = new SSEChunkInspector();
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let rawData = "";

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        rawData += chunk;

        // Process complete SSE messages
        if (chunk.includes("\n\n")) {
          const messages = rawData.split("\n\n");
          // biome-ignore lint/nursery/noIncrementDecrement: simple loop counter
          for (let i = 0; i < messages.length - 1; i += 1) {
            inspector.parseSSEStream(`${messages[i]}\n\n`);
          }
          rawData = messages.at(-1);
        }
      }
    }

    const report = inspector.getAnalysisReport();
    expect(report.totalChunks).toBeGreaterThan(0);
    expect(report.textContent).toMatch(COUNT_REGEX);
    expect(report.parsedChunks[0]).toHaveProperty(
      "object",
      "chat.completion.chunk"
    );
  });

  it("should handle empty messages array error", async () => {
    const request = {
      model: "wrapped-model",
      messages: [],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty("error");
    expect(data.error).toHaveProperty("message");
    expect(data.error).toHaveProperty("type", "invalid_request_error");
  });

  it("should handle missing messages field error", async () => {
    const request = {
      model: "wrapped-model",
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty("error");
    expect(data.error).toHaveProperty("type", "invalid_request_error");
  });

  it("should handle invalid JSON request", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "invalid json",
    });

    expect(response.status).toBe(400);
  });

  it("should handle CORS preflight requests", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(response.headers.get("access-control-allow-methods")).toBeTruthy();
  });
});
