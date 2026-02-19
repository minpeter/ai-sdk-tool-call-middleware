import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import {
  qwen3CoderProtocol,
  uiTarsXmlProtocol,
} from "../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../core/protocols/yaml-xml-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapStream } from "../../stream-handler";
import { stopFinishReason, zeroUsage } from "../test-helpers";

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

  const crossProtocolCoercionScenarios: Array<{
    name: string;
    protocol: TCMCoreProtocol;
    chunks: string[];
  }> = [
    {
      name: "hermes",
      protocol: hermesProtocol(),
      chunks: [
        '<tool_call>{"name":"calc","arg',
        'uments":{"a":"10","b":"false"}}</tool_call>',
      ],
    },
    {
      name: "morph-xml",
      protocol: morphXmlProtocol(),
      chunks: ["<calc>\n<a>10</a>\n<b>false</b>\n</calc>"],
    },
    {
      name: "yaml-xml",
      protocol: yamlXmlProtocol(),
      chunks: ['<calc>\na: "10"\nb: "false"\n</calc>'],
    },
    {
      name: "qwen3coder",
      protocol: qwen3CoderProtocol(),
      chunks: [
        "<tool_call><function=calc><parameter=a>10</parameter><parameter=b>false</parameter></function></tool_call>",
      ],
    },
    {
      name: "ui-tars-xml",
      protocol: uiTarsXmlProtocol(),
      chunks: [
        "<tool_call><function=calc><parameter=a>10</parameter><parameter=b>false</parameter></function></tool_call>",
      ],
    },
  ];

  for (const scenario of crossProtocolCoercionScenarios) {
    it(`${scenario.name} keeps streamed tool-input-delta aligned with final coerced tool-call input`, async () => {
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
            for (const chunk of scenario.chunks) {
              controller.enqueue({
                type: "text-delta",
                id: `seed-${scenario.name}`,
                delta: chunk,
              });
            }
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
        protocol: scenario.protocol,
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
          part.type === "tool-call" && part.toolName === "calc"
      );

      expect(parts.some((part) => part.type === "tool-input-start")).toBe(true);
      expect(parts.some((part) => part.type === "tool-input-end")).toBe(true);
      expect(streamedInput).toBe(toolCall?.input);
      expect(JSON.parse(streamedInput)).toEqual({ a: 10, b: false });
    });
  }

  it("streams tool-input-delta before delayed final chunk is released", async () => {
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

    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });

    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({
            type: "text-delta",
            id: "seed-streaming",
            delta: "<tool_call><function=calc><parameter=a>10</parameter>",
          });
          await secondChunkGate;
          controller.enqueue({
            type: "text-delta",
            id: "seed-streaming",
            delta: "<parameter=b>false</parameter></function></tool_call>",
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
      protocol: qwen3CoderProtocol(),
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

    const reader = result.stream.getReader();
    const earlyParts: LanguageModelV3StreamPart[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      earlyParts.push(value);
      if (value.type === "tool-input-delta") {
        break;
      }
    }

    releaseSecondChunk();

    const remainingParts: LanguageModelV3StreamPart[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      remainingParts.push(value);
    }

    const parts = [...earlyParts, ...remainingParts];
    const toolInputDeltas = parts.filter(
      (
        part
      ): part is Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    );
    const joined = toolInputDeltas.map((part) => part.delta).join("");
    const toolInputEndIndex = parts.findIndex(
      (part) => part.type === "tool-input-end"
    );
    const firstDeltaIndex = parts.findIndex(
      (part) => part.type === "tool-input-delta"
    );
    const toolCallIndex = parts.findIndex((part) => part.type === "tool-call");
    const toolCall = parts.find(
      (
        part
      ): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
        part.type === "tool-call" && part.toolName === "calc"
    );

    expect(earlyParts.some((part) => part.type === "tool-input-start")).toBe(
      true
    );
    expect(earlyParts.some((part) => part.type === "tool-input-delta")).toBe(
      true
    );
    expect(earlyParts.some((part) => part.type === "tool-input-end")).toBe(
      false
    );
    expect(earlyParts.some((part) => part.type === "tool-call")).toBe(false);

    expect(toolInputDeltas.length).toBeGreaterThanOrEqual(2);
    expect(firstDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(toolInputEndIndex).toBeGreaterThan(firstDeltaIndex);
    expect(toolCallIndex).toBeGreaterThan(toolInputEndIndex);
    expect(toolInputDeltas[0].delta.length).toBeLessThan(joined.length);
    expect(joined.startsWith(toolInputDeltas[0].delta)).toBe(true);
    expect(joined).toBe(toolCall?.input);
  });
});
