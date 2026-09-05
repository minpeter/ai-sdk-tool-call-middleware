import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { stopFinishReason, zeroUsage } from "../test-helpers";

const emptyGenerateResult = {
  content: [],
  finishReason: stopFinishReason,
  usage: zeroUsage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;
const doStream = vi.fn(async () => ({
  stream: new ReadableStream<LanguageModelV4StreamPart>(),
}));
const model: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: async () => emptyGenerateResult,
  doStream,
};

function wrapHermes(content: LanguageModelV4Content[]) {
  const middleware = createToolMiddleware({
    protocol: hermesProtocol({}),
    toolSystemPromptTemplate: (tools) =>
      `You have tools: ${JSON.stringify(tools)}`,
  });
  const doGenerate = vi.fn(async () => ({ ...emptyGenerateResult, content }));
  return middleware.wrapGenerate?.({
    doGenerate,
    doStream,
    params: { prompt: [] },
    model,
  });
}

describe("createToolMiddleware wrapGenerate hermes", () => {
  it("parses tool calls from text content", async () => {
    const result = await wrapHermes([
      {
        type: "text",
        text: 'Some text <tool_call>{"name": "getTool", "arguments": {"arg1": "value1"}}</tool_call> more text',
      },
    ]);
    expect(result).toBeDefined();
    expect(result?.content).toHaveLength(3);
    expect(result?.content[0]).toEqual({ type: "text", text: "Some text " });
    expect(result?.content[1]).toMatchObject({
      type: "tool-call",
      toolName: "getTool",
      input: '{"arg1":"value1"}',
    });
    expect(result?.content[2]).toEqual({ type: "text", text: " more text" });
  });

  it("passes through non-text content unchanged", async () => {
    const original = {
      type: "tool-call",
      toolCallId: "id1",
      toolName: "t",
      input: "{}",
    } satisfies LanguageModelV4Content;
    const result = await wrapHermes([original]);
    expect(result).toBeDefined();
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]).toEqual(original);
  });
});
