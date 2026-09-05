import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

const syntaxControl = vi.hoisted(() => ({ acceptToolCallOpen: true }));

vi.mock(
  "../../../../core/protocols/qwen3coder-call-syntax",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../core/protocols/qwen3coder-call-syntax")
      >();
    return {
      ...actual,
      TOOL_CALL_OPEN_RE: {
        test: (value: string) =>
          syntaxControl.acceptToolCallOpen &&
          actual.TOOL_CALL_OPEN_RE.test(value),
      },
      normalizeStreamToolCallInnerOpenVariants: () => ({
        status: "incomplete" as const,
      }),
    };
  }
);

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";

const tools = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
    },
  },
] satisfies LanguageModelV4FunctionTool[];

describe("qwen3CoderProtocol finish-time mode normalization", () => {
  it("buffers an opening tag rejected by the syntax recognizer as text", async () => {
    // Given
    syntaxControl.acceptToolCallOpen = false;
    const input = "<tool_call>visible";
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-delta", id: "1", delta: input });
        controller.close();
      },
    });

    // When
    const output = await convertReadableStreamToArray(
      pipeWithTransformer(
        stream,
        qwen3CoderProtocol().createStreamParser({ tools })
      )
    );
    syntaxControl.acceptToolCallOpen = true;

    // Then
    expect(
      output
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe(input);
  });

  it("reconciles a delayed single-call signal before a later nested opener", async () => {
    // Given
    const onError = vi.fn();
    const input =
      '<tool_call name="get_weather">' +
      "<parameter=city>Seoul</parameter><function";
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-delta", id: "1", delta: input });
        controller.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        controller.close();
      },
    });

    // When
    const output = await convertReadableStreamToArray(
      pipeWithTransformer(
        stream,
        qwen3CoderProtocol().createStreamParser({
          tools,
          options: { onError },
        })
      )
    );

    // Then
    expect(output.filter((part) => part.type === "tool-call")).toMatchObject([
      { toolName: "get_weather", input: '{"city":"Seoul"}' },
    ]);
    expect(onError).not.toHaveBeenCalled();
  });
});
