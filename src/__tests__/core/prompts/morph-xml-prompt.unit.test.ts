import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import {
  createMorphXmlToolResponseFormatter,
  morphFormatToolResponseAsXml,
  morphXmlSystemPromptTemplate,
} from "../../../core/prompts/morph-xml-prompt";

describe("morphXmlSystemPromptTemplate", () => {
  it("renders Morph XML examples from inputExamples", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather by city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            unit: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["city"],
        },
        inputExamples: [
          { input: { city: "Seoul", unit: "celsius" } },
          { input: { city: "Busan" } },
        ],
      },
    ];

    const prompt = morphXmlSystemPromptTemplate(tools);

    expect(prompt).toContain("# Decision Policy");
    expect(prompt).toContain("# Output Contract (when calling tools)");
    expect(prompt).toContain("# Input Examples");
    expect(prompt).toContain("Treat these as canonical tool-call patterns.");
    expect(prompt).toContain("Tool: get_weather");
    expect(prompt).toContain("Example 1:");
    expect(prompt).toContain("Example 2:");
    expect(prompt).toContain("<get_weather>");
    expect(prompt).toContain("<city>Seoul</city>");
    expect(prompt).toContain("<unit>celsius</unit>");
    expect(prompt).toContain("<city>Busan</city>");
  });

  it("does not render input example section when no examples are provided", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "search_docs",
        description: "Search docs",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ];

    const prompt = morphXmlSystemPromptTemplate(tools);

    expect(prompt).not.toContain("# Input Examples");
    expect(prompt).not.toContain("Tool: search_docs");
  });
});

describe("morphFormatToolResponseAsXml", () => {
  it("formats basic tool result with XML tags", () => {
    const result = morphFormatToolResponseAsXml({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "search",
      output: { type: "text", value: "found results" },
    } satisfies ToolResultPart);
    expect(result).toBe(
      [
        "<tool_response>",
        "  <tool_name>search</tool_name>",
        "  <result>found results</result>",
        "</tool_response>",
      ].join("\n")
    );
  });

  it("formats full XML response with nested result", () => {
    const result = morphFormatToolResponseAsXml({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "get_weather",
      output: {
        type: "json",
        value: {
          city: "New York",
          temperature: 47,
          condition: "sunny",
        },
      },
    } satisfies ToolResultPart);
    expect(result).toBe(
      [
        "<tool_response>",
        "  <tool_name>get_weather</tool_name>",
        "  <result>",
        "    <city>New York</city>",
        "    <temperature>47</temperature>",
        "    <condition>sunny</condition>",
        "  </result>",
        "</tool_response>",
      ].join("\n")
    );
  });

  it("does not escape XML special characters in tool name", () => {
    const result = morphFormatToolResponseAsXml({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "get<data>",
      output: { type: "text", value: "test" },
    } satisfies ToolResultPart);
    expect(result).toContain("<tool_name>get<data></tool_name>");
  });

  it("does not escape XML special characters in result", () => {
    const result = morphFormatToolResponseAsXml({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "search",
      output: {
        type: "text",
        value: 'Results for <query> with "quotes" & ampersand',
      },
    } satisfies ToolResultPart);
    expect(result).toContain(
      '<result>Results for <query> with "quotes" & ampersand</result>'
    );
  });

  it("unwraps json-typed result before formatting", () => {
    const result = morphFormatToolResponseAsXml({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "get_data",
      output: { type: "json", value: { key: "value" } },
    } satisfies ToolResultPart);
    expect(result).toContain("<key>value</key>");
    expect(result).not.toContain('"type":"json"');
  });

  it("handles content type with images gracefully", () => {
    const result = morphFormatToolResponseAsXml({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "screenshot",
      output: {
        type: "content",
        value: [
          { type: "text", text: "Screenshot captured" },
          { type: "image-data", data: "base64...", mediaType: "image/png" },
        ],
      },
    } satisfies ToolResultPart);
    expect(result).toContain("Screenshot captured");
    expect(result).toContain("[Image: image/png]");
  });

  it("formats object result as XML", () => {
    const result = morphFormatToolResponseAsXml({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "get_data",
      output: { type: "json", value: { nested: { data: true } } },
    } satisfies ToolResultPart);
    expect(result).toContain("<nested>");
    expect(result).toContain("<data>true</data>");
    expect(result).toContain("</nested>");
  });

  it("handles execution-denied result", () => {
    const result = morphFormatToolResponseAsXml({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "delete",
      output: { type: "execution-denied", reason: "Not authorized" },
    } satisfies ToolResultPart);
    expect(result).toContain("Execution Denied");
    expect(result).toContain("Not authorized");
  });

  it("factory supports auto media strategy with enabled image capability", () => {
    const formatter = createMorphXmlToolResponseFormatter({
      mediaStrategy: {
        mode: "auto",
        capabilities: {
          image: true,
        },
      },
    });

    const result = formatter({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "vision",
      output: {
        type: "content",
        value: [{ type: "image-url", url: "https://example.com/a.png" }],
      },
    } satisfies ToolResultPart);

    expect(result).toContain("<type>image-url</type>");
    expect(result).toContain("<url>https://example.com/a.png</url>");
  });
});
