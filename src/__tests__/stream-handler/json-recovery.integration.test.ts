import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapStream } from "../../stream-handler";
import { stopFinishReason, zeroUsage } from "../test-helpers";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
    },
  },
];

function providerStream(
  parts: LanguageModelV4StreamPart[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

describe("wrapStream bare-JSON tool call recovery", () => {
  it("recovers a wrapperless JSON tool call like the generate path does", async () => {
    // Real-world shape observed from GLM-4.7 through an OpenAI-compatible
    // endpoint: the whole content is a bare JSON payload without any
    // <tool_call> markup, delivered inside a normal provider text block.
    const doStream = vi.fn().mockResolvedValue({
      stream: providerStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t0" },
        {
          type: "text-delta",
          id: "t0",
          delta: '{"name": "get_weather", "arguments": {"city": "Seoul"}}',
        },
        { type: "text-end", id: "t0" },
        {
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        },
      ]),
    });

    const { stream } = await wrapStream({
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

    const out = await convertReadableStreamToArray(stream);

    const toolCall = out.find((p) => p.type === "tool-call") as Extract<
      LanguageModelV4StreamPart,
      { type: "tool-call" }
    >;
    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });

    // The JSON payload must not leak as visible text.
    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toBe("");

    // The tool-input lifecycle reconciles with the final tool call id.
    const inputStart = out.find((p) => p.type === "tool-input-start");
    expect((inputStart as { id?: string })?.id).toBe(toolCall.toolCallId);

    // finishReason parity with native tool calling.
    const finish = out.find((p) => p.type === "finish");
    expect((finish as { finishReason?: unknown })?.finishReason).toMatchObject({
      unified: "tool-calls",
    });
  });

  it("leaves ordinary text streams untouched", async () => {
    const doStream = vi.fn().mockResolvedValue({
      stream: providerStream([
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "Just a normal answer." },
        { type: "text-end", id: "t0" },
        {
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        },
      ]),
    });

    const { stream } = await wrapStream({
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

    const out = await convertReadableStreamToArray(stream);

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toBe("Just a normal answer.");
    const finish = out.find((p) => p.type === "finish");
    expect((finish as { finishReason?: unknown })?.finishReason).toEqual(
      stopFinishReason
    );
  });

  it("drops prototype-sensitive bare JSON tool candidates without text fallback", async () => {
    const doStream = vi.fn().mockResolvedValue({
      stream: providerStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t0" },
        {
          type: "text-delta",
          id: "t0",
          delta:
            '{"name":"get_weather","arguments":{"city":"Seoul","\\u0063onstructor":{"polluted":true}}}',
        },
        { type: "text-end", id: "t0" },
        {
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        },
      ]),
    });

    const { stream } = await wrapStream({
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

    const out = await convertReadableStreamToArray(stream);

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toBe("");
    const finish = out.find((p) => p.type === "finish");
    expect((finish as { finishReason?: unknown })?.finishReason).toEqual(
      stopFinishReason
    );
  });
});

describe("wrapStream toolChoice none passthrough", () => {
  it("returns the model stream untouched without parsing", async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: "text-start", id: "t0" },
      {
        type: "text-delta",
        id: "t0",
        delta: '<tool_call>{"name":"get_weather"}</tool_call>',
      },
      { type: "text-end", id: "t0" },
      { type: "finish", finishReason: stopFinishReason, usage: zeroUsage },
    ];
    const streamResult = { stream: providerStream(parts) };
    const doStream = vi.fn().mockResolvedValue(streamResult);

    const result = await wrapStream({
      protocol: hermesProtocol(),
      doStream,
      doGenerate: vi.fn(),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            toolChoice: { type: "none" },
          },
        },
      },
    });

    expect(result).toBe(streamResult);
    const out = await convertReadableStreamToArray(result.stream);
    expect(out).toEqual(parts);
  });
});
