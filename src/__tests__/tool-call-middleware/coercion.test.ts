import type {
  JSONSchema7,
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";
import { stopFinishReason, zeroUsage } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

// Minimal protocol that emits a fixed XML-like payload but routes through middleware coercion
const dummyProtocol: TCMCoreProtocol = {
  formatTools: ({ toolSystemPromptTemplate }) => toolSystemPromptTemplate([]),
  formatToolCall: () => "",
  parseGeneratedText: ({ tools }) => [
    {
      type: "tool-call",
      toolCallId: "id",
      toolName: tools[0]?.name ?? "calc",
      input: JSON.stringify({ a: "10", b: "false" }),
    } satisfies LanguageModelV4ToolCall,
  ],
  createStreamParser: () =>
    new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(),
};

const generateResult = {
  content: [{ type: "text", text: "" }],
  finishReason: stopFinishReason,
  usage: zeroUsage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;

const streamResult = {
  stream: new ReadableStream<LanguageModelV4StreamPart>(),
} satisfies LanguageModelV4StreamResult;

const model: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: async () => generateResult,
  doStream: async () => streamResult,
};

describe("tool-call-middleware coercion (utils)", () => {
  it("coerces using jsonSchema wrapper in tools via middleware", async () => {
    const middleware = createToolMiddleware({
      protocol: dummyProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const numericInput = { type: "number" } satisfies JSONSchema7;
    const booleanInput = { type: "boolean" } satisfies JSONSchema7;
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: { a: numericInput, b: booleanInput },
        },
      },
    ];

    if (!middleware.wrapGenerate) {
      throw new Error("wrapGenerate is not defined");
    }
    const result = await middleware.wrapGenerate({
      doGenerate: async () => generateResult,
      doStream: async () => streamResult,
      params: {
        prompt: [],
        tools,
        providerOptions: {
          // INFO: Since this test does not go through the transform handler
          // that normally injects this, we need to provide it manually.
          toolCallMiddleware: {
            originalTools: originalToolsSchema.encode(tools),
          },
        },
      },
      model,
    });

    const toolCall = result.content.find((part) => part.type === "tool-call");
    expect(toolCall).toBeTruthy();
    if (!toolCall) {
      throw new Error("Expected a tool call");
    }
    expect(JSON.parse(toolCall.input)).toEqual({ a: 10, b: false });
  });
});
