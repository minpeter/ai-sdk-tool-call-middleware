import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import { transformParams } from "../../transform-handler";
import { hermesProtocol } from "../protocols/hermes-protocol";
import {
  createHermesToolResponseFormatter,
  formatToolResponseAsHermes,
  hermesSystemPromptTemplate,
  jsonSchemaToPythonType,
  renderToolDefinition,
} from "./hermes-prompt";

describe("hermes-prompt outer-layer transform", () => {
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
      protocol: hermesProtocol(),
      placement: "first",
      toolSystemPromptTemplate: hermesSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsHermes,
      params: {
        prompt: inputPrompt,
        tools,
      },
    });

    const expectedPrompt: LanguageModelV3Prompt = [
      {
        role: "system",
        content: hermesSystemPromptTemplate(tools),
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
            text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<tool_response>{"name":"get_weather","content":{"city":"Seoul","temperature":21}}</tool_response>',
          },
        ],
      },
    ];

    expect(transformed.prompt).toEqual(expectedPrompt);
    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();
  });
});

describe("jsonSchemaToPythonType", () => {
  it('maps "string" to "str"', () => {
    expect(jsonSchemaToPythonType({ type: "string" })).toBe("str");
  });

  it('maps "number" to "float"', () => {
    expect(jsonSchemaToPythonType({ type: "number" })).toBe("float");
  });

  it('maps "integer" to "int"', () => {
    expect(jsonSchemaToPythonType({ type: "integer" })).toBe("int");
  });

  it('maps "boolean" to "bool"', () => {
    expect(jsonSchemaToPythonType({ type: "boolean" })).toBe("bool");
  });

  it("maps array with items to list[type]", () => {
    expect(
      jsonSchemaToPythonType({ type: "array", items: { type: "string" } })
    ).toBe("list[str]");
  });

  it("maps object with additionalProperties to dict[str, type]", () => {
    expect(
      jsonSchemaToPythonType({
        type: "object",
        additionalProperties: { type: "number" },
      })
    ).toBe("dict[str, float]");
  });

  it("maps object without additionalProperties to dict", () => {
    expect(jsonSchemaToPythonType({ type: "object" })).toBe("dict");
  });

  it("maps union type array to Union[...]", () => {
    expect(jsonSchemaToPythonType({ type: ["string", "integer"] })).toBe(
      "Union[str,int]"
    );
  });

  it("maps unknown/missing type to Any", () => {
    expect(jsonSchemaToPythonType({})).toBe("Any");
  });

  it("maps nested array/object/union structures recursively", () => {
    expect(
      jsonSchemaToPythonType({
        type: "array",
        items: {
          type: "object",
          additionalProperties: {
            type: ["string", "integer"],
          },
        },
      })
    ).toBe("list[dict[str, Union[str,int]]]");
  });

  it("maps deeply nested dictionary/list combinations", () => {
    expect(
      jsonSchemaToPythonType({
        type: "object",
        additionalProperties: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: {
              type: "number",
            },
          },
        },
      })
    ).toBe("dict[str, list[dict[str, float]]]");
  });
});

describe("renderToolDefinition", () => {
  it("renders tool with description and parameters", () => {
    const tool: LanguageModelV3FunctionTool = {
      type: "function",
      name: "get_weather",
      description: "Get weather by city",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", description: "The city name" },
        },
        required: ["city"],
      },
    };
    const result = renderToolDefinition(tool);
    expect(result).toContain('"type": "function"');
    expect(result).toContain('"function":');
    expect(result).toContain("get_weather");
    expect(result).toContain("Args:");
    expect(result).toContain("city(str):");
  });

  it("renders tool without description gracefully", () => {
    const tool: LanguageModelV3FunctionTool = {
      type: "function",
      name: "no_desc_tool",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "integer" },
        },
      },
    };
    const result = renderToolDefinition(tool);
    expect(result).toContain("no_desc_tool");
    expect(result).toContain('"type": "function"');
  });

  it("preserves the original schema when properties is empty", () => {
    const tool: LanguageModelV3FunctionTool = {
      type: "function",
      name: "no_params_tool",
      description: "No params",
      inputSchema: {
        type: "object",
        properties: {},
      },
    };

    const parsed = JSON.parse(renderToolDefinition(tool)) as {
      function: { parameters: unknown };
    };

    expect(parsed.function.parameters).toEqual(tool.inputSchema);
  });

  it("preserves schemas without properties (e.g. additionalProperties)", () => {
    const tool: LanguageModelV3FunctionTool = {
      type: "function",
      name: "dynamic_payload",
      description: "Accepts dynamic object values",
      inputSchema: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    };

    const parsed = JSON.parse(renderToolDefinition(tool)) as {
      function: { parameters: unknown };
    };

    expect(parsed.function.parameters).toEqual(tool.inputSchema);
  });

  it("escapes tool names safely when serializing", () => {
    const tool: LanguageModelV3FunctionTool = {
      type: "function",
      name: 'bad"name\\tool',
      description: "Escaping check",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
    };

    const parsed = JSON.parse(renderToolDefinition(tool)) as {
      function: { name: string };
    };

    expect(parsed.function.name).toBe('bad"name\\tool');
  });

  it("renders each Args entry on its own line", () => {
    const tool: LanguageModelV3FunctionTool = {
      type: "function",
      name: "two_params",
      description: "Two parameters",
      inputSchema: {
        type: "object",
        properties: {
          first: { type: "string", description: "First value" },
          second: { type: "integer", description: "Second value" },
        },
      },
    };

    const parsed = JSON.parse(renderToolDefinition(tool)) as {
      function: { description: string };
    };

    expect(parsed.function.description).toContain(
      "first(str): First value\n        second(int): Second value"
    );
  });

  it("renders complex nested parameter types in signature and args", () => {
    const tool: LanguageModelV3FunctionTool = {
      type: "function",
      name: "analyze_data",
      description: "Analyze deeply nested payload",
      inputSchema: {
        type: "object",
        properties: {
          filters: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: {
                type: ["string", "integer"],
              },
            },
            description: "Filter list",
          },
          metrics: {
            type: "object",
            additionalProperties: {
              type: "array",
              items: {
                type: "number",
              },
            },
            description: "Metric values",
          },
          rawPayload: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            description: "Raw payload object",
          },
        },
        required: ["filters"],
      },
    };

    const parsed = JSON.parse(renderToolDefinition(tool)) as {
      type: string;
      function: {
        name: string;
        description: string;
        parameters: unknown;
      };
    };

    expect(parsed.type).toBe("function");
    expect(parsed.function.name).toBe("analyze_data");
    expect(parsed.function.parameters).toEqual(tool.inputSchema);
    expect(parsed.function.description).toContain(
      "analyze_data(filters: list[dict[str, Union[str,int]]], metrics: dict[str, list[float]], rawPayload: dict)"
    );
    expect(parsed.function.description).toContain("Args:\n");
    expect(parsed.function.description).toContain(
      "filters(list[dict[str, Union[str,int]]]): Filter list"
    );
    expect(parsed.function.description).toContain(
      "metrics(dict[str, list[float]]): Metric values"
    );
    expect(parsed.function.description).toContain(
      "rawPayload(dict): Raw payload object"
    );
  });
});

describe("formatToolResponseAsHermes", () => {
  it("formats basic tool result", () => {
    const toolResult: ToolResultPart = {
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "get_weather",
      output: { type: "json", value: { temp: 25 } },
    };
    const result = formatToolResponseAsHermes(toolResult);
    expect(result).toContain("<tool_response>");
    expect(result).toContain("</tool_response>");
    expect(result).toContain('"name":"get_weather"');
    expect(result).toContain('"content":{"temp":25}');
  });

  it("unwraps json-typed result before formatting", () => {
    const result = formatToolResponseAsHermes({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "get_weather",
      output: { type: "json", value: { temp: 25 } },
    } satisfies ToolResultPart);
    expect(result).toContain('"content":{"temp":25}');
    expect(result).not.toContain('"type":"json"');
  });

  it("unwraps text-typed result before formatting", () => {
    const result = formatToolResponseAsHermes({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "echo",
      output: { type: "text", value: "hello world" },
    } satisfies ToolResultPart);
    expect(result).toContain('"content":"hello world"');
  });

  it("handles execution-denied result", () => {
    const result = formatToolResponseAsHermes({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "delete_file",
      output: { type: "execution-denied", reason: "Permission denied" },
    } satisfies ToolResultPart);
    expect(result).toContain("Execution Denied");
    expect(result).toContain("Permission denied");
  });

  it("handles error-text result", () => {
    const result = formatToolResponseAsHermes({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "fetch_data",
      output: { type: "error-text", value: "Network timeout" },
    } satisfies ToolResultPart);
    expect(result).toContain("Error");
    expect(result).toContain("Network timeout");
  });

  it("handles content type with images", () => {
    const result = formatToolResponseAsHermes({
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

  it("handles string output", () => {
    const result = formatToolResponseAsHermes({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "echo",
      output: { type: "text", value: "simple string" },
    } satisfies ToolResultPart);
    expect(result).toContain('"content":"simple string"');
  });

  it("factory supports raw media strategy", () => {
    const formatter = createHermesToolResponseFormatter({
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

    expect(result).toContain('"type":"image-url"');
    expect(result).toContain('"url":"https://example.com/a.png"');
  });
});

describe("hermesSystemPromptTemplate", () => {
  it("keeps the tool-call JSON example valid", () => {
    const rendered = hermesSystemPromptTemplate([]);
    expect(rendered).toContain(
      '{"name": "<function-name>", "arguments": <args-dict>}'
    );
  });

  it("adds spacing between tools block and next sentence", () => {
    const rendered = hermesSystemPromptTemplate([]);
    expect(rendered).toContain(
      "</tools>\nUse the following pydantic model json schema"
    );
    expect(rendered).not.toContain("</tools>Use");
  });
});
