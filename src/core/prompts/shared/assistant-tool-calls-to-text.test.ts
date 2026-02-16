import type { LanguageModelV3Content } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { assistantToolCallsToTextContent } from "./assistant-tool-calls-to-text";

describe("assistantToolCallsToTextContent", () => {
  it("converts assistant tool-call parts to formatted text and condenses when output is text-only", () => {
    const result = assistantToolCallsToTextContent({
      content: [
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "get_weather",
          input: "{}",
        },
        {
          type: "text",
          text: "after",
        },
      ] as LanguageModelV3Content[],
      protocol: {
        formatToolCall: () =>
          "<tool_call><function=get_weather></function></tool_call>",
      } as never,
    });

    expect(result).toEqual([
      {
        type: "text",
        text: "<tool_call><function=get_weather></function></tool_call>\nafter",
      },
    ]);
  });

  it("stringifies unknown assistant content and reports onError", () => {
    const onError = vi.fn();

    const result = assistantToolCallsToTextContent({
      content: [
        {
          type: "reasoning",
          text: "thinking",
        },
        {
          type: "unknown" as never,
          payload: { x: 1 },
        } as unknown as LanguageModelV3Content,
      ],
      protocol: {
        formatToolCall: () => "",
      } as never,
      conversionOptions: {
        onError,
      },
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "reasoning", text: "thinking" });
    expect(result[1]).toEqual({
      type: "text",
      text: JSON.stringify({ type: "unknown", payload: { x: 1 } }),
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
