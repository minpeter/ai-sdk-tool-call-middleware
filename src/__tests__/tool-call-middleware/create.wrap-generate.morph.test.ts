import type {
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";
import { stopFinishReason, zeroUsage } from "../test-helpers";

const baseline = {
  content: [],
  finishReason: stopFinishReason,
  usage: zeroUsage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;
const streamFallback = vi.fn(async () => ({
  stream: new ReadableStream<LanguageModelV4StreamPart>(),
}));
const morphModel: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: async () => baseline,
  doStream: streamFallback,
};

function generateMorph(text: string, tools: LanguageModelV4FunctionTool[]) {
  const middleware = createToolMiddleware({
    protocol: morphXmlProtocol,
    toolSystemPromptTemplate: (definitions) =>
      `You have tools: ${JSON.stringify(definitions)}`,
  });
  const generated = {
    ...baseline,
    content: [{ type: "text", text }],
  } satisfies LanguageModelV4GenerateResult;
  return middleware.wrapGenerate?.({
    doGenerate: vi.fn(async () => generated),
    doStream: streamFallback,
    params: {
      prompt: [],
      tools,
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode(tools),
        },
      },
    },
    model: morphModel,
  });
}

describe("createToolMiddleware wrapGenerate morph", () => {
  it("parses XML tool calls from text content", async () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "getTool",
        description: "Gets a tool",
        inputSchema: { type: "object" },
      },
    ];
    const result = await generateMorph(
      "Some text <getTool><arg1>value1</arg1></getTool> more text",
      tools
    );
    expect(result).toBeDefined();
    expect(result?.content).toHaveLength(3);
    const [before, toolCall, after] = result?.content ?? [];
    expect(before).toEqual({ type: "text", text: "Some text " });
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolName: "getTool",
      input: '{"arg1":"value1"}',
    });
    expect(after).toEqual({ type: "text", text: " more text" });
  });

  it("does not leak sensitive YAML tool_call fallback text", async () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "Gets weather",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ];
    const result = await generateMorph(
      "<tool_call>\nname: get_weather\narguments:\n  constructor: true\n  city: Seoul\n</tool_call>",
      tools
    );
    expect(result?.content).toEqual([]);
  });
});
