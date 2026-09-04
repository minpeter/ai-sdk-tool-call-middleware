import type {
  JSONObject,
  LanguageModelV4FunctionTool,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  sijawaraConciseXmlToolMiddleware,
  sijawaraDetailedXmlToolMiddleware,
  uiTarsToolMiddleware,
} from "../../community";
import { requireTransformParams } from "../test-helpers";

interface CommunityPromptCase {
  readonly absent?: string;
  readonly expected: readonly string[];
  readonly middleware: LanguageModelV4Middleware;
  readonly name: string;
  readonly tool: LanguageModelV4FunctionTool;
}

const model = new MockLanguageModelV4();

function weatherTool(input: JSONObject): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name: "get_weather",
    description: "Get weather by city",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    inputExamples: [{ input }],
  };
}

const cases: readonly CommunityPromptCase[] = [
  {
    name: "uiTarsToolMiddleware renders Input Examples in system prompt",
    middleware: uiTarsToolMiddleware,
    tool: {
      type: "function",
      name: "computer",
      description: "UI automation tool",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string" },
          coordinate: { type: "array", items: { type: "number" } },
        },
        required: ["action"],
      },
      inputExamples: [
        { input: { action: "left_click", coordinate: [100, 200] } },
      ],
    },
    expected: [
      "# Input Examples",
      "Tool: computer",
      "<tool_call>",
      "<function=computer>",
    ],
  },
  {
    name: "sijawaraDetailedXmlToolMiddleware renders Input Examples",
    middleware: sijawaraDetailedXmlToolMiddleware,
    tool: weatherTool({ city: "Seoul" }),
    expected: [
      "# Input Examples",
      "Tool: get_weather",
      "<get_weather>",
      "<city>Seoul</city>",
    ],
  },
  {
    name: "sijawaraConciseXmlToolMiddleware renders Input Examples",
    middleware: sijawaraConciseXmlToolMiddleware,
    tool: weatherTool({ city: "Busan" }),
    expected: [
      "# Input Examples",
      "Tool: get_weather",
      "<get_weather>",
      "<city>Busan</city>",
    ],
  },
  {
    name: "sijawaraDetailedXmlToolMiddleware falls back safely for invalid XML keys",
    middleware: sijawaraDetailedXmlToolMiddleware,
    tool: weatherTool({ "bad key": "Seoul" }),
    expected: [
      "# Input Examples",
      '<get_weather>{"bad key":"Seoul"}</get_weather>',
    ],
    absent: "<bad key>",
  },
];

async function renderedSystemPrompt(testCase: CommunityPromptCase) {
  const transformParams = requireTransformParams(
    testCase.middleware.transformParams
  );
  const output = await transformParams({
    type: "generate",
    model,
    params: { prompt: [], tools: [testCase.tool] },
  });
  const [system] = output.prompt;
  expect(system?.role).toBe("system");
  return String(system?.content ?? "");
}

describe("community middleware prompt templates", () => {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      const text = await renderedSystemPrompt(testCase);
      for (const sentinel of testCase.expected) {
        expect(text).toContain(sentinel);
      }
      if (testCase.absent !== undefined) {
        expect(text).not.toContain(testCase.absent);
      }
    });
  }
});
