import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { yamlXmlSystemPromptTemplate } from "../../../core/prompts/yaml-xml-prompt";

describe("yamlXmlSystemPromptTemplate", () => {
  it("renders Input Examples from tool.inputExamples", () => {
    const prompt = yamlXmlSystemPromptTemplate([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather by city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            unit: { type: "string" },
          },
          required: ["city"],
        },
        inputExamples: [
          {
            input: {
              city: "Seoul",
              unit: "celsius",
            },
          },
        ],
      } satisfies LanguageModelV3FunctionTool & {
        inputExamples: Array<{ input: unknown }>;
      },
    ]);

    expect(prompt).toContain("# Input Examples");
    expect(prompt).toContain("Tool: get_weather");
    expect(prompt).toContain("<get_weather>");
    expect(prompt).toContain("city: Seoul");
    expect(prompt).toContain("unit: celsius");
  });
});
