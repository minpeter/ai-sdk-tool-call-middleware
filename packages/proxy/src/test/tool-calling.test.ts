/**
 * Tool Calling Tests for OpenAI Proxy Server
 */

import { openai } from "@ai-sdk/openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAIProxyServer } from "../server.js";
import { SSEChunkInspector } from "./sse-chunk-inspector.js";

const LONDON_REGEX = /london/i;
const WEATHER_REGEX = /weather/i;

describe("OpenAI Proxy Server - Tool Calling", () => {
  let server: OpenAIProxyServer;
  const baseUrl = "http://localhost:3002";

  beforeAll(async () => {
    // Create tools for testing
    const _weatherTool = {
      description: "Get weather information for a city",
      parameters: z.object({
        city: z.string().describe("The city name"),
        units: z.enum(["celsius", "fahrenheit"]).optional(),
      }),
      execute: async () => ({
        latitude: 40.7128,
        longitude: -74.006,
        city: "New York",
        country: "USA",
      }),
    };

    const model = openai("gpt-3.5-turbo");

    server = new OpenAIProxyServer({
      model: model as any,
      port: 3002,
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

  it("should handle tool calls in non-streaming mode", async () => {
    const request = {
      model: "wrapped-model",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather in New York?" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather information for a city",
            parameters: {
              type: "object",
              properties: {
                city: {
                  type: "string",
                  description: "The city name",
                },
                units: {
                  type: "string",
                  enum: ["celsius", "fahrenheit"],
                  description: "Temperature units",
                },
              },
              required: ["city"],
            },
          },
        },
      ],
      temperature: 0.1,
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data).toHaveProperty("choices");
    expect((data as any).choices[0]).toHaveProperty(
      "finish_reason",
      "tool_calls"
    );
    expect((data as any).choices[0]).toHaveProperty("message");
    expect((data as any).choices[0].message).toHaveProperty("tool_calls");
    expect(Array.isArray((data as any).choices[0].message.tool_calls)).toBe(
      true
    );

    const toolCall = (data as any).choices[0].message.tool_calls[0];
    expect(toolCall).toHaveProperty("id");
    expect(toolCall).toHaveProperty("type", "function");
    expect(toolCall.function).toHaveProperty("name", "weather");
    expect(toolCall.function).toHaveProperty("arguments");

    const args = JSON.parse(toolCall.function.arguments);
    expect(args).toHaveProperty("city", "New York");
  });

  it("should handle multiple tool calls", async () => {
    const request = {
      model: "wrapped-model",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        {
          role: "user",
          content: "What is the weather in my current location?",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "location",
            description: "Get current location information",
            parameters: {
              type: "object",
              properties: {},
            },
          },
        },
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather information for a city",
            parameters: {
              type: "object",
              properties: {
                city: {
                  type: "string",
                  description: "The city name",
                },
              },
              required: ["city"],
            },
          },
        },
      ],
      temperature: 0.1,
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);

    const data = await response.json();
    expect((data as any).choices[0].finish_reason).toBe("tool_calls");
    expect((data as any).choices[0].message.tool_calls).toHaveLength(1);

    // Should call location tool first
    const toolCall = (data as any).choices[0].message.tool_calls[0];
    expect(toolCall.function.name).toBe("location");
  });

  it("should handle tool calls in streaming mode", async () => {
    const request = {
      model: "wrapped-model",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Get weather for Tokyo" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather information for a city",
            parameters: {
              type: "object",
              properties: {
                city: {
                  type: "string",
                  description: "The city name",
                },
              },
              required: ["city"],
            },
          },
        },
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
          for (let i = 0; i < messages.length - 1; i += 1) {
            inspector.parseSSEStream(`${messages[i]}\n\n`);
          }
          rawData = messages.at(-1) || "";
        }
      }
    }

    const report = inspector.getAnalysisReport();
    expect(report.totalChunks).toBeGreaterThan(0);

    // Should have tool call chunks
    const toolCallChunks = report.parsedChunks.filter(
      (chunk: any) => chunk.choices[0]?.delta?.tool_calls
    );
    expect(toolCallChunks.length).toBeGreaterThan(0);
  });

  it("should handle tool result messages", async () => {
    // First, get a tool call
    const toolRequest = {
      model: "wrapped-model",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather in London?" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather information for a city",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
          },
        },
      ],
      temperature: 0.1,
    };

    const toolResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toolRequest),
    });

    const toolData = await toolResponse.json();
    const toolCall = toolData.choices[0].message.tool_calls[0];

    // Now send the tool result
    const resultRequest = {
      model: "wrapped-model",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather in London?" },
        toolData.choices[0].message,
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            city: "London",
            temperature: 18,
            conditions: "cloudy",
            units: "celsius",
          }),
        },
      ],
      temperature: 0.1,
    };

    const resultResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resultRequest),
    });

    expect(resultResponse.ok).toBe(true);

    const resultData = await resultResponse.json();
    expect(resultData.choices[0].finish_reason).toBe("stop");
    expect(resultData.choices[0].message.content).toMatch(LONDON_REGEX);
    expect(resultData.choices[0].message.content).toMatch(WEATHER_REGEX);
  });

  it("should handle invalid tool schema", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "Test message" }],
      tools: [
        {
          type: "function",
          function: {
            name: "invalid_tool",
            description: "Tool with invalid schema",
            parameters: {
              // Invalid schema - missing type
              properties: {
                param: { description: "A parameter" },
              },
            },
          },
        },
      ],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    // Should handle gracefully or return appropriate error
    expect([200, 400, 500]).toContain(response.status);
  });

  it("should handle empty tools array", async () => {
    const request = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.choices[0].finish_reason).toBe("stop");
    expect(data.choices[0].message.content).toBeTruthy();
  });
});
