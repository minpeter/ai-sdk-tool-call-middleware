import { describe, expect, it } from "vitest";
import { convertAISDKResultToOpenAI } from "./response-converter.js";

interface ChoiceDeltaLike {
  delta?: {
    content?: string | null;
    tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  };
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      function?: { name?: string; arguments?: string };
    }> | null;
  };
  finish_reason?: string;
}

function extractChoices(json: unknown): ChoiceDeltaLike[] {
  const obj = json as { choices?: ChoiceDeltaLike[] };
  return obj.choices ?? [];
}

describe("convertAISDKResultToOpenAI - non-stream", () => {
  it("maps text and usage to chat.completion with message", () => {
    const result = convertAISDKResultToOpenAI(
      {
        text: "Hello",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      },
      "wrapped-model",
      false
    );

    expect(result.object).toBe("chat.completion");
    const choices = extractChoices(result);
    expect(choices.length).toBe(1);
    expect(choices[0]?.message?.content).toBe("Hello");
    expect(choices[0]?.finish_reason).toBe("stop");
    expect(result.usage).toEqual({
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
    });
  });

  it("maps toolCalls to message.tool_calls and finish_reason tool_calls", () => {
    const result = convertAISDKResultToOpenAI(
      {
        toolCalls: [{ toolName: "get_weather", args: { city: "Seoul" } }],
      },
      "wrapped-model",
      false
    );

    const choices = extractChoices(result);
    const tc = choices[0]?.message?.tool_calls;
    expect(Array.isArray(tc)).toBe(true);
    const fn = tc?.[0]?.function;
    expect(fn?.name).toBe("get_weather");
    const parsed = fn?.arguments ? JSON.parse(fn.arguments) : undefined;
    expect(parsed).toEqual({ city: "Seoul" });
    expect(choices[0]?.finish_reason).toBe("tool_calls");
  });
});

describe("convertAISDKResultToOpenAI - stream", () => {
  it("maps text to chat.completion.chunk with delta", () => {
    const result = convertAISDKResultToOpenAI(
      {
        text: "Hi",
        finishReason: "stop",
      },
      "wrapped-model",
      true
    );

    expect(result.object).toBe("chat.completion.chunk");
    const choices = extractChoices(result);
    expect(choices[0]?.delta?.content).toBe("Hi");
    expect(choices[0]?.finish_reason).toBe("stop");
  });

  it("maps toolCalls to delta.tool_calls and finish_reason tool_calls", () => {
    const result = convertAISDKResultToOpenAI(
      {
        toolCalls: [{ toolName: "get_weather", args: { city: "Tokyo" } }],
      },
      "wrapped-model",
      true
    );

    const choices = extractChoices(result);
    const tc = choices[0]?.delta?.tool_calls;
    expect(Array.isArray(tc)).toBe(true);
    const fn = tc?.[0]?.function;
    expect(fn?.name).toBe("get_weather");
    const parsed = fn?.arguments ? JSON.parse(fn.arguments) : undefined;
    expect(parsed).toEqual({ city: "Tokyo" });
    expect(choices[0]?.finish_reason).toBe("tool_calls");
  });
});
