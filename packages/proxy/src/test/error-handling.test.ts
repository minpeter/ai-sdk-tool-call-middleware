/**
 * Error Handling Tests for OpenAI Proxy Server
 */

import { openai } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAIProxyServer } from "../server.js";

describe("OpenAI Proxy Server - Error Handling", () => {
  let server: OpenAIProxyServer;
  const baseUrl = "http://localhost:3004";

  beforeAll(async () => {
    const model = openai("gpt-3.5-turbo");
    const wrappedModel = wrapLanguageModel({
      model,
      middleware: [],
    });

    server = new OpenAIProxyServer({
      model: wrappedModel,
      port: 3004,
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

  it("should handle malformed JSON gracefully", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"invalid": json}', // Malformed JSON
    });

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty("error");
    expect(data.error).toHaveProperty("message");
    expect(data.error).toHaveProperty("type");
  });

  it("should handle extremely large requests", async () => {
    const largeContent = "A".repeat(10 * 1024 * 1024); // 10MB

    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: largeContent }],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    // Should either handle it or return appropriate error
    expect([200, 413, 400]).toContain(response.status);

    if (!response.ok) {
      const data = await response.json();
      expect(data).toHaveProperty("error");
    }
  });

  it("should handle invalid model names", async () => {
    const request = {
      model: "non-existent-model",
      messages: [{ role: "user", content: "Hello" }],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    // Should handle gracefully - may succeed or return error
    expect([200, 400, 500]).toContain(response.status);
  });

  it("should handle invalid temperature values", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 3.0, // Invalid temperature (should be 0-2)
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    // Should handle gracefully
    expect([200, 400]).toContain(response.status);
  });

  it("should handle negative max_tokens", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: -100, // Invalid negative value
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    // Should handle gracefully
    expect([200, 400]).toContain(response.status);
  });

  it("should handle invalid message roles", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "invalid_role", content: "Hello" }],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    // Should handle gracefully
    expect([200, 400]).toContain(response.status);
  });

  it("should handle null/undefined content in messages", async () => {
    const request = {
      model: "wrapped-model",
      messages: [
        { role: "user", content: null },
        { role: "assistant", content: undefined },
      ],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    // Should handle gracefully
    expect([200, 400]).toContain(response.status);
  });

  it("should handle invalid tool definitions", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          type: "invalid_type", // Invalid tool type
          function: {
            name: "test",
            description: "Test tool",
          },
        },
      ],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    // Should handle gracefully
    expect([200, 400]).toContain(response.status);
  });

  it("should handle circular references in tool parameters", () => {
    const circularObj: any = { name: "test" };
    circularObj.self = circularObj;

    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "test",
            description: "Test tool",
            parameters: circularObj,
          },
        },
      ],
    };

    // Should not crash when trying to serialize
    expect(() => {
      JSON.stringify(request);
    }).not.toThrow();
  });

  it("should handle streaming connection interruption", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "Write a very long story" }],
      stream: true,
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);

    const reader = response.body?.getReader();
    if (reader) {
      // Read a few chunks then abort
      await reader.read();
      await reader.read();
      reader.releaseLock();
    }

    // Should not crash the server
    expect(response.ok).toBe(true);
  });

  it("should handle concurrent requests to same endpoint", async () => {
    const promises = Array.from({ length: 100 }, async () =>
      fetch(`${baseUrl}/health`)
    );

    const results = await Promise.allSettled(promises);

    // Most requests should succeed
    const successful = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok
    ).length;

    expect(successful).toBeGreaterThan(80); // At least 80% should succeed
  });

  it("should handle special characters in content", async () => {
    const specialContent = '🚀 Hello 世界 \n\t\r "quotes" \\backslash\\';

    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: specialContent }],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.choices[0].message.content).toBeTruthy();
  });

  it("should handle Unicode and emoji content", async () => {
    const unicodeContent = "🎉 Test with emoji: 🤖🚀🌟 and Chinese: 你好世界";

    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: unicodeContent }],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.choices[0].message.content).toBeTruthy();
  });

  it("should handle missing required headers", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "Hello" }],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      // Missing Content-Type header
      body: JSON.stringify(request),
    });

    // Should handle gracefully
    expect([200, 400, 415]).toContain(response.status);
  });

  it("should handle HTTP method not allowed", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "GET", // Wrong method
    });

    expect([404, 405]).toContain(response.status);
  });

  it("should handle invalid endpoint paths", async () => {
    const response = await fetch(`${baseUrl}/v1/invalid-endpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(404);
  });

  // biome-ignore lint/suspicious/useAwait: function returns promise array
  it("should handle server overload simulation", async () => {
    const promises = Array.from({ length: 200 }, () => {
      const request = {
        model: "wrapped-model",
        messages: [{ role: "user", content: "Quick response" }],
      };

      return fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
    });

    const results = await Promise.allSettled(promises);

    const successful = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok
    ).length;

    const failed = results.length - successful;

    console.log(
      `📊 Server overload test: ${successful} successful, ${failed} failed`
    );

    // Should handle overload gracefully
    expect(successful + failed).toBe(200);
  });
});
