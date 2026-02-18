import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import { transformParams } from "../../transform-handler";
import { qwen3CoderProtocol } from "../protocols/qwen3coder-protocol";
import {
  createQwen3CoderXmlToolResponseFormatter,
  formatToolResponseAsQwen3CoderXml,
  qwen3coderSystemPromptTemplate,
} from "./qwen3coder-prompt";

describe("qwen3coderSystemPromptTemplate", () => {
  it("renders the Qwen3-Coder tools section without chat-role wrappers", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "  Weather lookup  ",
        inputSchema: {
          type: "object",
          properties: {
            city: {
              type: "string",
              description: "  City name  ",
            },
            strict: {
              type: "boolean",
              default: false,
            },
          },
          required: ["city"],
          additionalProperties: false,
        },
      },
    ];

    const prompt = qwen3coderSystemPromptTemplate(tools);

    expect(
      prompt.startsWith(
        '# Tools\n\nYou have access to the following functions:\n\n<tools>\n<function>\n<name>get_weather</name>\n<description>Weather lookup</description>\n<parameters>\n<parameter>\n<name>city</name>\n<type>string</type>\n<description>City name</description>\n</parameter>\n<parameter>\n<name>strict</name>\n<type>boolean</type>\n<default>False</default>\n</parameter>\n<required>["city"]</required>\n<additionalProperties>False</additionalProperties>\n</parameters>\n</function>\n</tools>\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:'
      )
    ).toBe(true);
    expect(prompt).toContain("<IMPORTANT>");
    expect(prompt).toContain("</IMPORTANT>");
    expect(prompt).not.toContain("<|im_start|>");
    expect(prompt).not.toContain("<|im_end|>");
  });

  it("returns empty string when no tools are provided", () => {
    expect(qwen3coderSystemPromptTemplate([])).toBe("");
  });

  it("escapes XML-sensitive values and renders non-XML extra keys safely", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "A < B & C",
        inputSchema: {
          type: "object",
          properties: {
            "city<name": {
              type: "string",
              description: "x < y & z",
            },
          },
          required: ["city<name"],
          $schema: "https://example.com/schema?x=1&y=<z>",
        },
      },
    ];

    const prompt = qwen3coderSystemPromptTemplate(tools);

    expect(prompt).toContain("<description>A &lt; B &amp; C</description>");
    expect(prompt).toContain("<name>city&lt;name</name>");
    expect(prompt).toContain("<description>x &lt; y &amp; z</description>");
    expect(prompt).toContain('<required>["city&lt;name"]</required>');
    expect(prompt).toContain(
      '<property name="$schema">https://example.com/schema?x=1&amp;y=&lt;z></property>'
    );
    expect(prompt).not.toContain("<$schema>");
  });
});

describe("qwen3coder-prompt outer-layer transform", () => {
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
      protocol: qwen3CoderProtocol(),
      placement: "first",
      toolSystemPromptTemplate: qwen3coderSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsQwen3CoderXml,
      params: {
        prompt: inputPrompt,
        tools,
      },
    });

    const expectedPrompt: LanguageModelV3Prompt = [
      {
        role: "system",
        content: qwen3coderSystemPromptTemplate(tools),
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
            text: `<tool_call>
  <function="get_weather">
    <parameter="city">Seoul</parameter>
  </function>
</tool_call>`,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<tool_response>
{"city":"Seoul","temperature":21}
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

describe("formatToolResponseAsQwen3CoderXml", () => {
  it("formats object result as raw JSON text within <tool_response>", () => {
    const result = formatToolResponseAsQwen3CoderXml({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "get_weather",
      output: { type: "json", value: { temperature: 21 } },
    } satisfies ToolResultPart);

    expect(result).toBe(
      `<tool_response>\n{"temperature":21}\n</tool_response>`
    );
  });

  it("preserves text result verbatim within <tool_response>", () => {
    const result = formatToolResponseAsQwen3CoderXml({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "get_weather",
      output: { type: "text", value: "ok" },
    } satisfies ToolResultPart);

    expect(result).toBe("<tool_response>\nok\n</tool_response>");
  });

  it("factory supports raw media strategy", () => {
    const formatter = createQwen3CoderXmlToolResponseFormatter({
      mediaStrategy: {
        mode: "raw",
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

    expect(result).toBe(
      '<tool_response>\n[{"type":"image-url","url":"https://example.com/a.png"}]\n</tool_response>'
    );
  });
});
