import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../core/protocols/hermes-protocol";
import type { TCMCoreProtocol } from "../core/protocols/protocol-interface";
import { originalToolsSchema } from "../core/utils/provider-options";
import { wrapStream } from "../stream-handler";
import { stopFinishReason, zeroUsage } from "./test-helpers";

const passthroughProtocol: TCMCoreProtocol = {
  formatTools: ({ toolSystemPromptTemplate }) => toolSystemPromptTemplate([]),
  formatToolCall: () => "",
  parseGeneratedText: () => [],
  createStreamParser: () => new TransformStream(),
};

describe("wrapStream tool-call coercion", () => {
  it("coerces streamed tool-call input using originalTools schema", async () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "boolean" },
          },
        },
      },
    ];

    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: "id",
            toolName: "calc",
            input: '{"a":"10","b":"false"}',
          });
          controller.enqueue({
            type: "finish",
            finishReason: {
              unified: "tool-calls",
              raw: "tool-calls",
            },
            usage: {
              inputTokens: {
                total: 0,
                noCache: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: {
                total: 0,
                text: 0,
                reasoning: 0,
              },
            },
          });
          controller.close();
        },
      }),
    });

    const result = await wrapStream({
      protocol: passthroughProtocol,
      doStream,
      doGenerate: vi.fn(),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    });
    const parts = await convertReadableStreamToArray(result.stream);

    expect(parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "calc",
      input: '{"a":10,"b":false}',
    });
  });

  it("emits tool-input-delta while streaming tool-call arguments", async () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        inputSchema: {
          type: "object",
          properties: {
            location: { type: "string" },
            unit: { type: "string" },
          },
          required: ["location"],
        },
      },
    ];

    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({
            type: "text-delta",
            id: "seed",
            delta: '<tool_call>{"name":"get_weather","arg',
          });
          controller.enqueue({
            type: "text-delta",
            id: "seed",
            delta: 'uments":{"location":"Seoul","unit":"celsius"}}</tool_call>',
          });
          controller.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          controller.close();
        },
      }),
    });

    const result = await wrapStream({
      protocol: hermesProtocol(),
      doStream,
      doGenerate: vi.fn(),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    });

    const parts = await convertReadableStreamToArray(result.stream);
    const toolInputStartIndex = parts.findIndex(
      (part) => part.type === "tool-input-start"
    );
    const toolInputDeltaIndex = parts.findIndex(
      (part) => part.type === "tool-input-delta"
    );
    const toolInputEndIndex = parts.findIndex(
      (part) => part.type === "tool-input-end"
    );
    const toolCallIndex = parts.findIndex((part) => part.type === "tool-call");

    const toolInputDeltas = parts.filter(
      (
        part
      ): part is Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    );
    const toolCall = parts.find(
      (
        part
      ): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
        part.type === "tool-call"
    );

    expect(toolInputStartIndex).toBeGreaterThanOrEqual(0);
    expect(toolInputDeltaIndex).toBeGreaterThan(toolInputStartIndex);
    expect(toolInputEndIndex).toBeGreaterThan(toolInputDeltaIndex);
    expect(toolCallIndex).toBeGreaterThan(toolInputEndIndex);
    expect(toolInputDeltas.length).toBeGreaterThan(0);
    expect(toolCall).toBeDefined();
    expect(toolInputDeltas.map((part) => part.delta).join("")).toBe(
      toolCall?.input
    );
  });

  // TODO: tool-input-delta is emitted before wrapStream coercion, so raw deltas may remain.
  // Align streamed deltas with final coerced tool-call input once real-time coercion is available.
  it("can produce drift between streamed tool-input-delta and final coerced tool-call input", async () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "boolean" },
          },
          required: ["a", "b"],
        },
      },
    ];

    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({
            type: "text-delta",
            id: "seed",
            delta: '<tool_call>{"name":"calc","arg',
          });
          controller.enqueue({
            type: "text-delta",
            id: "seed",
            delta: 'uments":{"a":"10","b":"false"}}</tool_call>',
          });
          controller.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          controller.close();
        },
      }),
    });

    const result = await wrapStream({
      protocol: hermesProtocol(),
      doStream,
      doGenerate: vi.fn(),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
    });

    const parts = await convertReadableStreamToArray(result.stream);
    const streamedInput = parts
      .filter(
        (
          part
        ): part is Extract<
          LanguageModelV3StreamPart,
          { type: "tool-input-delta" }
        > => part.type === "tool-input-delta"
      )
      .map((part) => part.delta)
      .join("");
    const toolCall = parts.find(
      (
        part
      ): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
        part.type === "tool-call"
    );

    expect(streamedInput).toBe('{"a":"10","b":"false"}');
    expect(toolCall?.input).toBe('{"a":10,"b":false}');
    expect(streamedInput).not.toBe(toolCall?.input);
  });
});
