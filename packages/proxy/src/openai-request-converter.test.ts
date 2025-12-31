import { describe, expect, it } from "vitest";
import {
  convertOpenAIRequestToAISDK,
  mapOpenAIToolChoice,
} from "./openai-request-converter.js";
import type { OpenAIChatRequest } from "./types.js";

describe("convertOpenAIRequestToAISDK", () => {
  it("maps core fields and tool_choice correctly", () => {
    const req: OpenAIChatRequest = {
      model: "wrapped-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
      max_tokens: 123,
      temperature: 0.7,
      stop: ["END"],
    };

    const out = convertOpenAIRequestToAISDK(req);

    expect(out.temperature).toBe(0.7);
    expect(out.maxOutputTokens).toBe(123);
    expect(out.stopSequences).toEqual(["END"]);
    expect(out.toolChoice).toEqual({ type: "tool", toolName: "get_weather" });

    expect(out.messages?.length).toBe(1);
    expect(out.messages?.[0]).toMatchObject({ role: "user", content: "hello" });

    // tool mapping (runtime shape)
    expect(out.tools).toBeDefined();
    const toolsAny = out.tools as Record<string, unknown> | undefined;
    const getWeather = (toolsAny?.get_weather ?? {}) as {
      description?: string;
      inputSchema?: unknown;
    };
    expect(getWeather.description).toBe("Get weather");
    expect(getWeather.inputSchema).toBeDefined();
  });
});

describe("mapOpenAIToolChoice", () => {
  it("maps auto/none and function selection", () => {
    expect(mapOpenAIToolChoice("auto")).toBe("auto");
    expect(mapOpenAIToolChoice("none")).toBe("none");
    expect(
      mapOpenAIToolChoice(
        undefined as unknown as OpenAIChatRequest["tool_choice"]
      )
    ).toBeUndefined();
    const choice = {
      type: "function",
      function: { name: "x" },
    } as unknown as OpenAIChatRequest["tool_choice"];
    expect(mapOpenAIToolChoice(choice)).toEqual({
      type: "tool",
      toolName: "x",
    });
  });
});
