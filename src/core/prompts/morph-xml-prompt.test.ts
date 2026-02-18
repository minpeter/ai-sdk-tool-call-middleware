import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import { transformParams } from "../../transform-handler";
import { morphXmlProtocol } from "../protocols/morph-xml-protocol";
import {
  createMorphXmlToolResponseFormatter,
  morphFormatToolResponseAsXml,
  morphXmlSystemPromptTemplate,
} from "./morph-xml-prompt";

describe("morph-xml-prompt outer-layer transform", () => {
  it("transforms tools + messages into the expected prompt message array", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather by city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
      },
    ];

    const inputPrompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [{ type: "text", text: "오늘 서울 날씨 알려줘" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-weather",
            toolName: "get_weather",
            input: JSON.stringify({ city: "Seoul" }),
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-weather",
            toolName: "get_weather",
            output: {
              type: "json",
              value: {
                city: "Seoul",
                temperature: 21,
              },
            },
          },
        ],
      },
    ];

    const transformed = transformParams({
      protocol: morphXmlProtocol({}),
      placement: "first",
      toolSystemPromptTemplate: morphXmlSystemPromptTemplate,
      toolResponsePromptTemplate: morphFormatToolResponseAsXml,
      params: {
        prompt: inputPrompt,
        tools,
      },
    });

    const expectedPrompt: LanguageModelV3Prompt = [
      {
        role: "system",
        content: morphXmlSystemPromptTemplate(tools),
      },
      {
        role: "user",
        content: [{ type: "text", text: "오늘 서울 날씨 알려줘" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `<get_weather>
  <city>Seoul</city>
</get_weather>`,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<tool_response>
  <tool_name>get_weather</tool_name>
  <result>
    <city>Seoul</city>
    <temperature>21</temperature>
  </result>
</tool_response>`,
          },
        ],
      },
    ];

    expect(transformed.prompt).toEqual(expectedPrompt);
    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();
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
