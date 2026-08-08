import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import {
  formatToolResponseAsKExaone2,
  kExaone2SystemPromptTemplate,
} from "../../../core/prompts/k-exaone-2-prompt";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get weather by city",
    inputSchema: JSON.stringify({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    }) as unknown as LanguageModelV4FunctionTool["inputSchema"],
  },
];

describe("kExaone2SystemPromptTemplate", () => {
  it("renders native K-EXAONE-2.0 tool declarations and call instructions", () => {
    const prompt = kExaone2SystemPromptTemplate(tools);

    expect(prompt).toContain("# Tools");
    expect(prompt).toContain('<tool>{"type":"function","function":');
    expect(prompt).toContain('"name":"get_weather"');
    expect(prompt).toContain('"parameters":{"type":"object"');
    expect(prompt).toContain("# Tool Call Format");
    expect(prompt).toContain("<function=example_tool_name>");
    expect(prompt).toContain("<parameter=arg1>");
  });

  it("renders input examples in K-EXAONE-2.0 call format", () => {
    const prompt = kExaone2SystemPromptTemplate([
      {
        ...tools[0],
        inputExamples: [{ input: { city: "Seoul" } }],
      } as LanguageModelV4FunctionTool,
    ]);

    expect(prompt).toContain("# Input Examples");
    expect(prompt).toContain("<function=get_weather>");
    expect(prompt).toContain("<parameter=city>\nSeoul\n</parameter>");
  });
});

describe("formatToolResponseAsKExaone2", () => {
  it("wraps string and JSON results in tool_result tags", () => {
    const textResult = formatToolResponseAsKExaone2({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "get_weather",
      output: { type: "text", value: "sunny" },
    } satisfies ToolResultPart);
    const jsonResult = formatToolResponseAsKExaone2({
      type: "tool-result",
      toolCallId: "tc2",
      toolName: "get_weather",
      output: { type: "json", value: { temperature: 21 } },
    } satisfies ToolResultPart);

    expect(textResult).toBe("<tool_result>sunny</tool_result>");
    expect(jsonResult).toBe('<tool_result>{"temperature":21}</tool_result>');
  });
});
