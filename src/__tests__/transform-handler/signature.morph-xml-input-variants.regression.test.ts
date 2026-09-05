import type {
  JSONValue,
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlToolMiddleware } from "../../preconfigured-middleware";
import { requireTransformParams } from "../test-helpers";

const model: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "morph-signature",
  supportedUrls: {},
  doGenerate: () => Promise.reject(new TypeError("Unused generate")),
  doStream: () => Promise.reject(new TypeError("Unused stream")),
};

const WEATHER_TAG = /<get_weather[>/]/;
const EDIT_FILE_TAG = /<edit_file>/;

interface SignatureFixture {
  readonly input: JSONValue | undefined;
  readonly output: JSONValue;
  readonly question: string;
  readonly tool: LanguageModelV4FunctionTool;
}

async function morphSignatureText(fixture: SignatureFixture): Promise<string> {
  const prompt: LanguageModelV4Prompt = [
    {
      role: "user",
      content: [{ type: "text", text: fixture.question }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: fixture.tool.name,
          input: fixture.input,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: fixture.tool.name,
          toolCallId: "tc1",
          output: { type: "json", value: fixture.output },
        },
      ],
    },
  ];
  const transform = requireTransformParams(
    morphXmlToolMiddleware.transformParams
  );
  const out = await transform({
    type: "generate",
    model,
    params: { prompt, tools: [fixture.tool] },
  });
  const assistantTexts = out.prompt.flatMap((message) => {
    if (message.role !== "assistant") {
      return [];
    }
    return message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text);
  });
  expect(assistantTexts).not.toHaveLength(0);
  return assistantTexts.join("");
}

const weatherTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get the weather",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
  },
};

const editTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "edit_file",
  description: "Edit a file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_str: { type: "string" },
      new_str: { type: "string" },
      replace_all: { type: "boolean" },
    },
  },
};

describe("transformParams morph-xml tool-call signature regression", () => {
  it("preserves morph-xml tool-call signature when input is undefined", async () => {
    const text = await morphSignatureText({
      input: undefined,
      output: { temperature: 25 },
      question: "What's the weather?",
      tool: weatherTool,
    });
    expect(text).toMatch(WEATHER_TAG);
  });

  it("preserves tool-call signature when input is object", async () => {
    const text = await morphSignatureText({
      input: {
        path: "/test/file.ts",
        old_str: "foo",
        new_str: "bar",
        replace_all: false,
      },
      output: { success: true },
      question: "Edit the file",
      tool: editTool,
    });
    expect(text).toMatch(EDIT_FILE_TAG);
    expect(text).toContain("path");
  });
});
