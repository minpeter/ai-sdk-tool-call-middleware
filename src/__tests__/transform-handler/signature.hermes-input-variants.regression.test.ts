import type {
  JSONValue,
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { hermesToolMiddleware } from "../../preconfigured-middleware";
import { requireTransformParams } from "../test-helpers";

function signatureModel(): LanguageModelV4 {
  const unused = () => {
    throw new TypeError("Signature model is never executed");
  };
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "hermes-signature",
    supportedUrls: {},
    doGenerate: unused,
    doStream: unused,
  };
}

const TOOL_CALL_TAG = /<tool_call>/;

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get the weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
    },
  },
];

function signaturePrompt(input: JSONValue | undefined): LanguageModelV4Prompt {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "What's the weather?" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "get_weather",
          input,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "get_weather",
          toolCallId: "tc1",
          output: { type: "json", value: { temperature: 25 } },
        },
      ],
    },
  ];
}

async function transformedAssistantText(
  prompt: LanguageModelV4Prompt,
  toolDefinitions: LanguageModelV4FunctionTool[]
): Promise<string> {
  const transform = requireTransformParams(
    hermesToolMiddleware.transformParams
  );
  const out = await transform({
    type: "generate",
    model: signatureModel(),
    params: { prompt, tools: toolDefinitions },
  });
  const assistant = out.prompt.find((message) => message.role === "assistant");
  expect(assistant).toBeTruthy();
  if (assistant?.role !== "assistant") {
    throw new TypeError("Assistant message not found");
  }
  expect(Array.isArray(assistant.content)).toBe(true);
  return assistant.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

const singleInputCases = [
  {
    name: "preserves tool-call signature when input is undefined",
    input: undefined,
  },
  {
    name: "preserves tool-call signature when input is empty string",
    input: "",
  },
  { name: "preserves tool-call signature when input is null", input: null },
] satisfies readonly {
  readonly input: JSONValue | undefined;
  readonly name: string;
}[];

describe("transformParams hermes tool-call signature regression", () => {
  for (const testCase of singleInputCases) {
    it(testCase.name, async () => {
      const text = await transformedAssistantText(
        signaturePrompt(testCase.input),
        tools
      );
      expect(text).toMatch(TOOL_CALL_TAG);
      expect(text).toContain("get_weather");
    });
  }

  it("preserves signatures for multiple tool calls with mixed input types", async () => {
    const multiTools: LanguageModelV4FunctionTool[] = [
      ...tools,
      {
        type: "function",
        name: "get_time",
        description: "Get the time",
        inputSchema: {
          type: "object",
          properties: { timezone: { type: "string" } },
        },
      },
    ];
    const prompt: LanguageModelV4Prompt = [
      {
        role: "user",
        content: [{ type: "text", text: "Weather and time?" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "get_weather",
            input: JSON.stringify({ city: "Seoul" }),
          },
          {
            type: "tool-call",
            toolCallId: "tc2",
            toolName: "get_time",
            input: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "get_weather",
            toolCallId: "tc1",
            output: { type: "json", value: { temperature: 25 } },
          },
          {
            type: "tool-result",
            toolName: "get_time",
            toolCallId: "tc2",
            output: { type: "json", value: { time: "10:00 AM" } },
          },
        ],
      },
    ];
    const text = await transformedAssistantText(prompt, multiTools);
    expect(text).toContain("get_weather");
    expect(text).toContain("get_time");
    expect(text).toMatch(TOOL_CALL_TAG);
  });
});
