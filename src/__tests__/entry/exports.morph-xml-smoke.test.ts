import type {
  JSONObject,
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlToolMiddleware, originalToolsSchema } from "../../index";
import { stopFinishReason, zeroUsage } from "../test-helpers";

type GeneratedToolCall = Extract<LanguageModelV4Content, { type: "tool-call" }>;

interface MorphSmokeCase {
  readonly description: string;
  readonly expectedInput: JSONObject;
  readonly name: string;
  readonly text: string;
  readonly toolName: string;
}

const emptyGenerateResult = {
  content: [],
  finishReason: stopFinishReason,
  usage: zeroUsage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;
const doStream = async () => ({
  stream: new ReadableStream<LanguageModelV4StreamPart>(),
});
const model: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: async () => emptyGenerateResult,
  doStream,
};

const smokeCases: readonly MorphSmokeCase[] = [
  {
    name: "parses XML tool calls with arguments",
    toolName: "get_weather",
    description: "Get the weather",
    text: "<get_weather><location>San Francisco</location></get_weather>",
    expectedInput: { location: "San Francisco" },
  },
  {
    name: "parses XML tool calls with no arguments",
    toolName: "get_location",
    description: "Get the user's location",
    text: "<get_location></get_location>",
    expectedInput: {},
  },
];

function requireToolCall(
  content: readonly LanguageModelV4Content[]
): GeneratedToolCall {
  const toolCalls = content.filter(
    (part): part is GeneratedToolCall => part.type === "tool-call"
  );
  expect(toolCalls).toHaveLength(1);
  const [toolCall] = toolCalls;
  if (toolCall === undefined) {
    throw new TypeError("Expected one generated tool call");
  }
  return toolCall;
}

function runMorphSmoke(testCase: MorphSmokeCase) {
  const tools: LanguageModelV4FunctionTool[] = [
    {
      type: "function",
      name: testCase.toolName,
      description: testCase.description,
      inputSchema: { type: "object" },
    },
  ];
  const { wrapGenerate } = morphXmlToolMiddleware;
  if (wrapGenerate === undefined) {
    throw new TypeError("Morph XML wrapGenerate export is required");
  }
  return wrapGenerate({
    doGenerate: () =>
      Promise.resolve({
        ...emptyGenerateResult,
        content: [{ type: "text", text: testCase.text }],
      } satisfies LanguageModelV4GenerateResult),
    doStream,
    params: {
      prompt: [],
      tools,
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode(tools),
        },
      },
    },
    model,
  });
}

describe("entry exports morph-xml smoke", () => {
  for (const testCase of smokeCases) {
    it(testCase.name, async () => {
      const result = await runMorphSmoke(testCase);

      expect(result).toBeDefined();
      const toolCall = requireToolCall(result.content);
      expect(toolCall.toolName).toBe(testCase.toolName);
      expect(JSON.parse(toolCall.input)).toEqual(testCase.expectedInput);
    });
  }
});
