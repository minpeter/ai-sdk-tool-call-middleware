import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes/protocol";
import {
  encodeOriginalTools,
  type ToolCallMiddlewareDebugSummary,
} from "../../core/utils/transport/provider-options";
import { wrapStream } from "../../stream-handler";

const weatherTools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

async function drainStream(
  stream: ReadableStream<LanguageModelV4StreamPart>
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parts.push(value);
  }
  return parts;
}

describe("wrapStream debugSummary parity with wrapGenerate", () => {
  it("populates debugSummary for parsed streaming tool calls", async () => {
    const debugSummary: ToolCallMiddlewareDebugSummary = {};
    const { stream } = await wrapStream({
      protocol: hermesProtocol(),
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta: '<tool_call>{"name":"get_weather",',
              });
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta: '"arguments":{"city":"Seoul"}}</tool_call>',
              });
              controller.enqueue({ type: "text-end", id: "t1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 1,
                    text: undefined,
                    reasoning: undefined,
                  },
                },
              });
              controller.close();
            },
          }),
        }),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            debugSummary,
            _internal: {
              originalTools: encodeOriginalTools(weatherTools),
            },
          },
        },
      },
    });

    await drainStream(stream);

    expect(debugSummary.originalText).toBe(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>'
    );
    expect(JSON.parse(debugSummary.toolCalls ?? "[]")).toEqual([
      { toolName: "get_weather", input: '{"city":"Seoul"}' },
    ]);
  });

  it("redacts prototype-sensitive payloads in streaming debugSummary", async () => {
    const debugSummary: ToolCallMiddlewareDebugSummary = {};
    const { stream } = await wrapStream({
      protocol: hermesProtocol(),
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta:
                  '<tool_call>{"name":"get_weather","arguments":{"constructor":"polluted"}}</tool_call>',
              });
              controller.enqueue({ type: "text-end", id: "t1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 1,
                    text: undefined,
                    reasoning: undefined,
                  },
                },
              });
              controller.close();
            },
          }),
        }),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            debugSummary,
            _internal: {
              originalTools: encodeOriginalTools(weatherTools),
            },
          },
        },
      },
    });

    await drainStream(stream);

    expect(debugSummary.originalText).toBe("[redacted sensitive tool call]");
    expect(JSON.stringify(debugSummary)).not.toContain("constructor");
    expect(JSON.stringify(debugSummary)).not.toContain("polluted");
  });
});
