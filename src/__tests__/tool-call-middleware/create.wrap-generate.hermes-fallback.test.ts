import type {
  JSONSchema7,
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";
import { stopFinishReason, zeroUsage } from "../test-helpers";

const fallbackGenerated = {
  content: [],
  finishReason: stopFinishReason,
  usage: zeroUsage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;
const fallbackStream = vi.fn(async () => ({
  stream: new ReadableStream<LanguageModelV4StreamPart>(),
}));
function fallbackModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: async () => fallbackGenerated,
    doStream: fallbackStream,
  };
}

function weatherTools(
  properties: Record<string, JSONSchema7>
): LanguageModelV4FunctionTool[] {
  return [
    {
      type: "function",
      name: "get_weather",
      description: "",
      inputSchema: {
        type: "object",
        properties,
        required: ["city"],
        additionalProperties: false,
      },
    },
  ];
}

function generateFallback(text: string, tools: LanguageModelV4FunctionTool[]) {
  const middleware = createToolMiddleware({
    protocol: hermesProtocol({}),
    toolSystemPromptTemplate: (definitions) =>
      `You have tools: ${JSON.stringify(definitions)}`,
  });
  const generated = {
    ...fallbackGenerated,
    content: [{ type: "text", text }],
  } satisfies LanguageModelV4GenerateResult;
  return middleware.wrapGenerate?.({
    doGenerate: vi.fn(async () => generated),
    doStream: fallbackStream,
    params: {
      prompt: [],
      tools,
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode(tools),
        },
      },
    },
    model: fallbackModel(),
  });
}

function parsedToolInput(result: Awaited<ReturnType<typeof generateFallback>>) {
  const toolCall = result?.content.find((part) => part.type === "tool-call");
  expect(toolCall).toBeTruthy();
  if (toolCall?.type !== "tool-call") {
    throw new TypeError("Expected recovered tool-call content");
  }
  expect(toolCall.toolName).toBe("get_weather");
  return JSON.parse(toolCall.input);
}

const citySchema: Record<string, JSONSchema7> = {
  city: { type: "string" },
};
const weatherSchema: Record<string, JSONSchema7> = {
  ...citySchema,
  unit: { type: "string" },
};

describe("createToolMiddleware wrapGenerate hermes JSON fallback", () => {
  it("recovers bare JSON tool payload when protocol parsing returns no tool-call", async () => {
    const result = await generateFallback(
      '{"name":"get_weather","arguments":{"city":"Seoul","unit":"celsius"}}',
      weatherTools(weatherSchema)
    );
    expect(parsedToolInput(result)).toEqual({ city: "Seoul", unit: "celsius" });
  });

  it("recovers single-tool bare arguments and drops schema-unknown keys", async () => {
    const result = await generateFallback(
      '{"city":"Seoul","mood":"sunny"}',
      weatherTools(citySchema)
    );
    expect(parsedToolInput(result)).toEqual({ city: "Seoul" });
  });

  it("preserves surrounding text when JSON fallback recovers from fenced payload", async () => {
    const result = await generateFallback(
      [
        "Before",
        "```json",
        '{"name":"get_weather","arguments":{"city":"Seoul","unit":"celsius"}}',
        "```",
        "After",
      ].join("\n"),
      weatherTools(weatherSchema)
    );
    expect(result?.content).toHaveLength(3);
    const [before, toolCall, after] = result?.content ?? [];
    if (!(before && toolCall && after)) {
      throw new TypeError("Expected before, tool-call, and after content");
    }
    expect(before).toEqual({ type: "text", text: "Before\n" });
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
    });
    if (toolCall.type !== "tool-call") {
      throw new TypeError("Expected fenced tool-call content");
    }
    expect(JSON.parse(toolCall.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
    expect(after).toEqual({ type: "text", text: "\nAfter" });
  });

  it("recovers arguments-only JSON object for single strict tool schema", async () => {
    const result = await generateFallback(
      '{"city":"Busan","unit":"celsius"}',
      weatherTools(weatherSchema)
    );
    expect(parsedToolInput(result)).toEqual({ city: "Busan", unit: "celsius" });
  });

  it("does not recover arguments-only JSON when keys do not match strict schema", async () => {
    const result = await generateFallback(
      '{"foo":"bar"}',
      weatherTools(citySchema)
    );
    expect(result?.content).toEqual([{ type: "text", text: '{"foo":"bar"}' }]);
  });
});
