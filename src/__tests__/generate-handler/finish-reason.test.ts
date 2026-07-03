import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapGenerate } from "../../generate-handler";
import { mockFinishReason, zeroUsage } from "../test-helpers";

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

const toolCallProtocol: TCMCoreProtocol = {
  formatTools: ({ toolSystemPromptTemplate }) => toolSystemPromptTemplate([]),
  formatToolCall: () => "",
  parseGeneratedText: ({ text }) =>
    text.includes("CALL")
      ? [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            input: '{"city":"Seoul"}',
          },
        ]
      : [{ type: "text", text }],
  createStreamParser: () => new TransformStream(),
};

function makeParams() {
  return {
    providerOptions: {
      toolCallMiddleware: {
        originalTools: originalToolsSchema.encode(tools),
      },
    },
  };
}

function makeResult(text: string, finishReason: unknown) {
  return {
    content: [{ type: "text", text }],
    finishReason,
    usage: zeroUsage,
    warnings: [],
  };
}

describe("wrapGenerate finishReason parity with streaming", () => {
  it("rewrites stop to tool-calls when a tool call was parsed", async () => {
    const doGenerate = vi
      .fn()
      .mockResolvedValue(makeResult("CALL", mockFinishReason("stop")));

    const result = await wrapGenerate({
      protocol: toolCallProtocol,
      doGenerate,
      params: makeParams(),
    });

    expect(result.content[0]).toMatchObject({ type: "tool-call" });
    expect(result.finishReason).toEqual({
      unified: "tool-calls",
      raw: "stop",
    });
  });

  it("rewrites other to tool-calls when a tool call was parsed", async () => {
    const doGenerate = vi
      .fn()
      .mockResolvedValue(makeResult("CALL", { unified: "other", raw: "eos" }));

    const result = await wrapGenerate({
      protocol: toolCallProtocol,
      doGenerate,
      params: makeParams(),
    });

    expect(result.finishReason).toEqual({
      unified: "tool-calls",
      raw: "eos",
    });
  });

  it("preserves meaningful finish reasons such as length", async () => {
    const doGenerate = vi
      .fn()
      .mockResolvedValue(makeResult("CALL", mockFinishReason("length")));

    const result = await wrapGenerate({
      protocol: toolCallProtocol,
      doGenerate,
      params: makeParams(),
    });

    expect(result.content[0]).toMatchObject({ type: "tool-call" });
    expect(result.finishReason).toEqual(mockFinishReason("length"));
  });

  it("keeps the model finish reason when no tool call was parsed", async () => {
    const doGenerate = vi
      .fn()
      .mockResolvedValue(makeResult("plain answer", mockFinishReason("stop")));

    const result = await wrapGenerate({
      protocol: toolCallProtocol,
      doGenerate,
      params: makeParams(),
    });

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.finishReason).toEqual(mockFinishReason("stop"));
  });

  it("rewrites finishReason for forced tool choice results", async () => {
    const doGenerate = vi
      .fn()
      .mockResolvedValue(
        makeResult(
          '{"name":"get_weather","arguments":{"city":"Seoul"}}',
          mockFinishReason("stop")
        )
      );

    const result = await wrapGenerate({
      protocol: toolCallProtocol,
      doGenerate,
      params: {
        providerOptions: {
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
            toolChoice: { type: "required" },
          },
        },
      },
    });

    expect(result.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
    });
    expect(result.finishReason).toMatchObject({ unified: "tool-calls" });
  });
});

describe("wrapGenerate toolChoice none passthrough", () => {
  it("returns the model result untouched without parsing", async () => {
    const parseSpy = vi.fn(() => []);
    const spyProtocol: TCMCoreProtocol = {
      ...toolCallProtocol,
      parseGeneratedText: parseSpy,
    };
    const modelResult = makeResult(
      '<tool_call>{"name":"x"}</tool_call>',
      mockFinishReason("stop")
    );
    const doGenerate = vi.fn().mockResolvedValue(modelResult);

    const result = await wrapGenerate({
      protocol: spyProtocol,
      doGenerate,
      params: {
        providerOptions: {
          toolCallMiddleware: {
            toolChoice: { type: "none" },
          },
        },
      },
    });

    expect(result).toBe(modelResult);
    expect(parseSpy).not.toHaveBeenCalled();
  });
});
