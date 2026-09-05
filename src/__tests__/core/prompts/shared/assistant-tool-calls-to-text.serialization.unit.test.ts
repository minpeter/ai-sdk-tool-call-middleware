import type { LanguageModelV4Content } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { assistantToolCallsToTextContent } from "../../../../core/prompts/shared/assistant-tool-calls-to-text";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

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
      ] satisfies LanguageModelV4Content[],
      protocol: hermesProtocol(),
    });

    expect(result).toEqual([
      {
        type: "text",
        text: '<tool_call>{"name":"get_weather","arguments":{}}</tool_call>\nafter',
      },
    ]);
  });

  it("stringifies unsupported assistant content and reports onError", () => {
    const onError = vi.fn();

    const result = assistantToolCallsToTextContent({
      content: [
        {
          type: "reasoning",
          text: "thinking",
        },
        {
          type: "custom",
          kind: "test.payload",
        },
      ],
      protocol: hermesProtocol(),
      conversionOptions: {
        onError,
      },
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "reasoning", text: "thinking" });
    expect(result[1]).toEqual({
      type: "text",
      text: JSON.stringify({ type: "custom", kind: "test.payload" }),
    });
    expect(onError).toHaveBeenCalledWith(
      "tool-call-middleware: unknown assistant content; stringifying for provider compatibility",
      { content: { type: "custom", kind: "test.payload" } }
    );
  });

  it("normalizes binary SDK file data in error metadata without changing provider text", () => {
    // Given
    const onError = vi.fn();
    const fileContent = {
      type: "file",
      mediaType: "application/octet-stream",
      data: { type: "data", data: new Uint8Array([0, 127, 255]) },
      providerMetadata: {
        provider: { nested: { values: [1, { preserved: true }] } },
      },
    } satisfies LanguageModelV4Content;

    // When
    const result = assistantToolCallsToTextContent({
      content: [fileContent],
      protocol: hermesProtocol(),
      conversionOptions: { onError },
    });

    // Then
    expect(result).toEqual([
      { type: "text", text: JSON.stringify(fileContent) },
    ]);
    expect(onError).toHaveBeenCalledWith(
      "tool-call-middleware: unknown assistant content; stringifying for provider compatibility",
      {
        content: {
          type: "file",
          mediaType: "application/octet-stream",
          data: {
            type: "data",
            data: { type: "Uint8Array", values: [0, 127, 255] },
          },
          providerMetadata: {
            provider: { nested: { values: [1, { preserved: true }] } },
          },
        },
      }
    );
  });
});
