import type {
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, test, vi } from "vitest";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { createToolMiddleware } from "../../tool-call-middleware";
import { mockUsage, stopFinishReason, zeroUsage } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get the weather",
    inputSchema: { type: "object" },
  },
];

const generateResult = {
  content: [],
  finishReason: stopFinishReason,
  usage: zeroUsage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;

const model: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: async () => generateResult,
  doStream: async () => ({
    stream: new ReadableStream<LanguageModelV4StreamPart>(),
  }),
};

function morphInputStream(deltas: readonly string[]) {
  const parts: LanguageModelV4StreamPart[] = [
    { type: "text-start", id: "text-1" },
    ...deltas.map(
      (delta): LanguageModelV4StreamPart => ({
        type: "text-delta",
        id: "text-1",
        delta,
      })
    ),
    { type: "text-end", id: "text-1" },
    {
      type: "finish",
      finishReason: stopFinishReason,
      usage: mockUsage(1, 1),
    },
  ];
  const iterator = parts.values();
  return new ReadableStream<LanguageModelV4StreamPart>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
  });
}

async function collectMorphMiddleware(
  deltas: readonly string[]
): Promise<LanguageModelV4StreamPart[]> {
  const middleware = createToolMiddleware({
    protocol: morphXmlProtocol,
    toolSystemPromptTemplate: () => "",
  });
  if (!middleware.wrapStream) {
    throw new Error("wrapStream is undefined");
  }
  const result = await middleware.wrapStream({
    doGenerate: async () => generateResult,
    doStream: async () => ({ stream: morphInputStream(deltas) }),
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
  return convertReadableStreamToArray(result.stream);
}

interface MorphCallScenario {
  readonly deltas: readonly string[];
  readonly expectedInput: string;
  readonly name: string;
}

const callScenarios: readonly MorphCallScenario[] = [
  {
    name: "should handle standard XML tool calls correctly",
    deltas: [
      "<get_wea",
      "ther>",
      "<location>San Fransisco</location>",
      "</get_",
      "weather>",
    ],
    expectedInput: '{"location":"San Fransisco"}',
  },
  {
    name: "should handle argument-less XML tool calls correctly",
    deltas: ["<get_weather>", "</get_weather>"],
    expectedInput: "{}",
  },
  {
    name: "should handle self-closing XML tool calls correctly (issue #84)",
    deltas: ["<get_weather/>"],
    expectedInput: "{}",
  },
  {
    name: "should handle self-closing XML tool calls split across chunks (issue #84)",
    deltas: ["<get_wea", "ther/>"],
    expectedInput: "{}",
  },
];

describe("createToolMiddleware morphXml stream compat", () => {
  for (const scenario of callScenarios) {
    test(scenario.name, async () => {
      const chunks = await collectMorphMiddleware(scenario.deltas);
      const toolCallChunks = chunks.filter(
        (chunk) => chunk.type === "tool-call"
      );
      expect(toolCallChunks).toHaveLength(1);
      expect(toolCallChunks[0]).toMatchObject({
        type: "tool-call",
        toolName: "get_weather",
        input: scenario.expectedInput,
      });
    });
  }

  test("should not leak sensitive YAML tool_call fallback text", async () => {
    const chunks = await collectMorphMiddleware([
      "<tool_call>\nname: get_weather\narguments:\n  constructor: true\n  city: Seoul\n</tool_call>",
    ]);
    expect(chunks.some((chunk) => chunk.type === "tool-call")).toBe(false);
    const text = chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.delta)
      .join("");
    expect(text).not.toContain("constructor");
    expect(text).not.toContain("<tool_call>");
  });
});
