import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes/protocol";
import type { TCMProtocol } from "../../core/protocols/protocol-interface";
import {
  encodeOriginalTools,
  type ToolCallMiddlewareDebugSummary,
} from "../../core/utils/transport/provider-options";
import { wrapGenerate } from "../../generate-handler";
import { toolChoiceStream, wrapStream } from "../../stream-handler";

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

  it("records matching empty debugSummary in both wrapGenerate and wrapStream, overwriting stale state", async () => {
    const generateSummary: ToolCallMiddlewareDebugSummary = {
      originalText: "stale-generate",
      toolCalls: '[{"toolName":"stale","input":"{}"}]',
    };
    const streamSummary: ToolCallMiddlewareDebugSummary = {
      originalText: "stale-stream",
      toolCalls: '[{"toolName":"stale","input":"{}"}]',
    };

    await wrapGenerate({
      protocol: hermesProtocol(),
      doGenerate: () =>
        Promise.resolve({
          content: [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: {
              total: 1,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: 0,
              text: undefined,
              reasoning: undefined,
            },
          },
          warnings: [],
        }),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            debugSummary: generateSummary,
            _internal: {
              originalTools: encodeOriginalTools(weatherTools),
            },
          },
        },
      },
    });

    const { stream } = await wrapStream({
      protocol: hermesProtocol(),
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
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
                    total: 0,
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
            debugSummary: streamSummary,
            _internal: {
              originalTools: encodeOriginalTools(weatherTools),
            },
          },
        },
      },
    });
    await drainStream(stream);

    expect(generateSummary).toEqual({
      originalText: "",
      toolCalls: "[]",
    });
    expect(streamSummary).toEqual(generateSummary);
  });

  it("records matching forced toolChoice debugSummary in wrapGenerate and toolChoiceStream", async () => {
    const generateSummary: ToolCallMiddlewareDebugSummary = {};
    const streamSummary: ToolCallMiddlewareDebugSummary = {};
    const payload = '{"name":"get_weather","arguments":{"city":"Busan"}}';
    const mockGenerate = () =>
      Promise.resolve({
        content: [{ type: "text" as const, text: payload }],
        finishReason: { unified: "stop" as const, raw: "stop" },
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
        warnings: [],
      });

    await wrapGenerate({
      protocol: hermesProtocol(),
      doGenerate: mockGenerate,
      params: {
        providerOptions: {
          toolCallMiddleware: {
            debugSummary: generateSummary,
            _internal: {
              originalTools: encodeOriginalTools(weatherTools),
              toolChoice: { type: "tool", toolName: "get_weather" },
            },
          },
        },
      },
    });

    const { stream } = await toolChoiceStream({
      doGenerate: mockGenerate,
      tools: weatherTools,
      expectedToolName: "get_weather",
      debugSummary: streamSummary,
    });
    await drainStream(stream);

    expect(generateSummary).toEqual({
      originalText: payload,
      toolCalls: JSON.stringify([
        { toolName: "get_weather", input: '{"city":"Busan"}' },
      ]),
    });
    expect(streamSummary).toEqual(generateSummary);
  });

  it("preserves multi-block boundaries and records debugSummary on stream flush without finish", async () => {
    const observedTexts: string[] = [];
    const base = hermesProtocol();
    const protocol: TCMProtocol = {
      ...base,
      extractToolCallSegments({ text, tools }) {
        observedTexts.push(text);
        return base.extractToolCallSegments?.({ text, tools }) ?? [];
      },
    };
    const debugSummary: ToolCallMiddlewareDebugSummary = {};

    const { stream } = await wrapStream({
      protocol,
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta: "block-one",
              });
              controller.enqueue({ type: "text-end", id: "t1" });
              controller.enqueue({ type: "text-start", id: "t2" });
              controller.enqueue({
                type: "text-delta",
                id: "t2",
                delta:
                  '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>',
              });
              controller.enqueue({ type: "text-end", id: "t2" });
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

    expect(observedTexts).toEqual([
      'block-one\n\n<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>',
    ]);
    expect(debugSummary.originalText).toBe(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>'
    );
  });

  it("isolates throwing extractToolCallSegments and preserves protocol `this` receiver", async () => {
    const onError = vi.fn();
    const debugSummary: ToolCallMiddlewareDebugSummary = {};
    const throwingProtocol: TCMProtocol = {
      ...hermesProtocol(),
      extractToolCallSegments() {
        throw new Error("extractor exploded");
      },
    };

    const { stream } = await wrapStream({
      protocol: throwingProtocol,
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
                  '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>',
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
            onError,
            _internal: {
              originalTools: encodeOriginalTools(weatherTools),
            },
          },
        },
      },
    });

    const parts = await drainStream(stream);
    expect(parts.some((part) => part.type === "tool-call")).toBe(true);
    expect(parts.at(-1)?.type).toBe("finish");
    expect(onError).toHaveBeenCalledWith(
      "Failed to extract tool call segments for debug summary.",
      { error: "extractor exploded" }
    );
    expect(debugSummary.originalText).toBe("");
    expect(JSON.parse(debugSummary.toolCalls ?? "[]")).toEqual([
      { toolName: "get_weather", input: '{"city":"Seoul"}' },
    ]);
  });
});
