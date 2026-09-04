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
  let index = 0;
  return new ReadableStream<LanguageModelV4StreamPart>({
    pull(controller) {
      const part = parts[index];
      if (part === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(part);
      index += 1;
    },
  });
}

function requireFinish(parts: LanguageModelV4StreamPart[]) {
  const finish = parts.find((part) => part.type === "finish");
  if (finish?.type !== "finish") {
    throw new TypeError("Expected finish stream part");
  }
  return finish;
}

async function runWrappedStream(parts: LanguageModelV4StreamPart[]) {
  const doStream = vi.fn().mockResolvedValue({ stream: providerStream(parts) });
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
  return convertReadableStreamToArray(stream);
}

function streamedText(parts: LanguageModelV4StreamPart[]): string {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("");
}

describe("wrapStream bare-JSON tool call recovery", () => {
  it("recovers a wrapperless JSON tool call like the generate path does", async () => {
    // Real-world shape observed from GLM-4.7 through an OpenAI-compatible
    // endpoint: the whole content is a bare JSON payload with no
    // <tool_call> markup, delivered inside a normal provider text block.
    const out = await runWrappedStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t0" },
      {
        type: "text-delta",
        id: "t0",
        delta: '{"name": "get_weather", "arguments": {"city": "Seoul"}}',
      },
      { type: "text-end", id: "t0" },
      { type: "finish", finishReason: stopFinishReason, usage: zeroUsage },
    ]);

    const toolCall = out.find((part) => part.type === "tool-call");
    if (toolCall?.type !== "tool-call") {
      throw new TypeError("Expected tool-call stream part");
    }
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });

    // The JSON payload must not leak as visible text.
    expect(streamedText(out)).toBe("");

    // The tool-input lifecycle reconciles with the final tool call id.
    const inputStart = out.find((part) => part.type === "tool-input-start");
    if (inputStart?.type !== "tool-input-start") {
      throw new TypeError("Expected tool-input-start stream part");
    }
    expect(inputStart.id).toBe(toolCall.toolCallId);

    // finishReason parity with native tool calling.
    expect(requireFinish(out).finishReason).toMatchObject({
      unified: "tool-calls",
    });
  });

  it("leaves ordinary text streams untouched", async () => {
    const out = await runWrappedStream([
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "Just a normal answer." },
      { type: "text-end", id: "t0" },
      { type: "finish", finishReason: stopFinishReason, usage: zeroUsage },
    ]);

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(streamedText(out)).toBe("Just a normal answer.");
    const ordinaryFinish = requireFinish(out);
    expect(ordinaryFinish.finishReason).toEqual(stopFinishReason);
  });

  it("drops prototype-sensitive bare JSON tool candidates without text fallback", async () => {
    const out = await runWrappedStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t0" },
      {
        type: "text-delta",
        id: "t0",
        delta:
          '{"name":"get_weather","arguments":{"city":"Seoul","\\u0063onstructor":{"polluted":true}}}',
      },
      { type: "text-end", id: "t0" },
      { type: "finish", finishReason: stopFinishReason, usage: zeroUsage },
    ]);

    expect(out.some(({ type }) => type === "tool-call")).toBe(false);
    expect(streamedText(out)).toBe("");
    expect(requireFinish(out).finishReason).toEqual(stopFinishReason);
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
