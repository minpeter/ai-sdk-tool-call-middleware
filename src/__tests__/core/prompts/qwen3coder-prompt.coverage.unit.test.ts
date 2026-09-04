import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";

import {
  createQwen3CoderXmlToolResponseFormatter,
  formatToolResponseAsQwen3CoderXml,
  qwen3coderSystemPromptTemplate,
} from "../../../core/prompts/qwen3coder-prompt";

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const FUNCTION_OPEN = "<function=";
const PARAMETER_OPEN = "<parameter=";
const TOOL_RESPONSE_OPEN = "<tool_response>";
const TOOL_RESPONSE_CLOSE = "</tool_response>";

function toolWithSchema(
  inputSchema: LanguageModelV4FunctionTool["inputSchema"]
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name: "coverage_tool",
    inputSchema,
  };
}

describe("Qwen3-Coder prompt structural coverage", () => {
  it("returns no protocol envelope without tools", () => {
    // Given
    const tools: LanguageModelV4FunctionTool[] = [];

    // When
    const prompt = qwen3coderSystemPromptTemplate(tools);

    // Then
    expect(prompt).toBe("");
  });

  it("renders schema sentinel values and safe fallback property tags", () => {
    // Given
    const enabledSchema = {
      type: "boolean",
      description: " true flag ",
      default: null,
      const: false,
      readOnly: true,
      enum: [true, false, null],
      examples: [{ nested: 1 }],
      $schema: "escaped&value",
    } satisfies LanguageModelV4FunctionTool["inputSchema"];
    const tools = [
      {
        type: "function",
        name: "coverage_tool",
        description: " structural-description ",
        inputSchema: {
          type: "object",
          properties: {
            enabled: enabledSchema,
            unconstrained: true,
          },
          required: ["enabled"],
          additionalProperties: false,
        },
      },
    ] satisfies LanguageModelV4FunctionTool[];

    // When
    const prompt = qwen3coderSystemPromptTemplate(tools);

    // Then
    expect(prompt).toContain("<name>coverage_tool</name>");
    expect(prompt).toContain(
      "<description>structural-description</description>"
    );
    expect(prompt).toContain("<name>enabled</name>");
    expect(prompt).toContain("<default>None</default>");
    expect(prompt).toContain("<const>False</const>");
    expect(prompt).toContain("<readOnly>True</readOnly>");
    expect(prompt).toContain("<enum>[true,false,null]</enum>");
    expect(prompt).toContain('<examples>[{"nested":1}]</examples>');
    expect(prompt).toContain(
      '<property name="$schema">escaped&amp;value</property>'
    );
    expect(prompt).toContain("<name>unconstrained</name>");
  });

  it.each([
    { schemaText: '{"type":"object","sentinel":7}', hasSentinel: true },
    { schemaText: "true", hasSentinel: false },
    { schemaText: "not-json", hasSentinel: false },
  ])(
    "normalizes string schema input $schemaText",
    ({ schemaText, hasSentinel }) => {
      // Given
      const tool = toolWithSchema({});
      Object.defineProperty(tool, "inputSchema", { value: schemaText });

      // When
      const prompt = qwen3coderSystemPromptTemplate([tool]);

      // Then
      expect(prompt.includes("<sentinel>7</sentinel>")).toBe(hasSentinel);
    }
  );

  it("falls back when a non-string schema is not a schema record", () => {
    // Given
    const tool = toolWithSchema({});
    Object.defineProperty(tool, "inputSchema", { value: true });

    // When
    const prompt = qwen3coderSystemPromptTemplate([tool]);

    // Then
    expect(prompt).not.toContain("<type>");
  });

  it("falls back when a schema copy serializes to a non-object", () => {
    // Given
    const schema = {
      type: "object",
      toJSON: () => null,
    };
    const tool = toolWithSchema({});
    Object.defineProperty(tool, "inputSchema", { value: schema });

    // When
    const prompt = qwen3coderSystemPromptTemplate([tool]);

    // Then
    expect(prompt).toContain("<parameters>");
    expect(prompt).not.toContain("<type>object</type>");
  });

  it("renders a non-mapping input example through the input fallback", () => {
    // Given
    const tool = toolWithSchema({ type: "object" });
    Object.defineProperty(tool, "inputExamples", {
      value: [{ input: Symbol("example") }],
    });

    // When
    const prompt = qwen3coderSystemPromptTemplate([tool]);

    // Then
    expect(prompt).toContain(`${PARAMETER_OPEN}input>\nSymbol(example)`);
  });

  it("renders mapping, empty mapping, scalar, and string input examples", () => {
    // Given
    const tool = {
      ...toolWithSchema({ type: "object" }),
      inputExamples: [{ input: { path: "a<&", count: 2 } }, { input: {} }],
    } satisfies LanguageModelV4FunctionTool;
    const scalarTool = {
      ...toolWithSchema({ type: "object" }),
      name: "scalar_tool",
      inputExamples: [{ input: { value: true } }],
    } satisfies LanguageModelV4FunctionTool;

    // When
    const prompt = qwen3coderSystemPromptTemplate([tool, scalarTool]);

    // Then
    expect(prompt).toContain(TOOL_CALL_OPEN);
    expect(prompt).toContain(TOOL_CALL_CLOSE);
    expect(prompt).toContain(`${FUNCTION_OPEN}coverage_tool>`);
    expect(prompt).toContain(`${PARAMETER_OPEN}path>\na&lt;&amp;`);
    expect(prompt).toContain(`${PARAMETER_OPEN}count>\n2`);
    expect(prompt).toContain(`${PARAMETER_OPEN}input>\n{}`);
    expect(prompt).toContain(`${PARAMETER_OPEN}value>\ntrue`);
  });
});

describe("Qwen3-Coder tool response structural coverage", () => {
  it.each([
    { output: { type: "text", value: "ok" } },
    { output: { type: "json", value: { ok: true } } },
  ] satisfies Pick<ToolResultPart, "output">[])(
    "wraps $output.type output in one response envelope",
    ({ output }) => {
      // Given
      const toolResult = {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "coverage_tool",
        output,
      } satisfies ToolResultPart;

      // When
      const result = formatToolResponseAsQwen3CoderXml(toolResult);

      // Then
      expect(typeof result).toBe("string");
      if (typeof result !== "string") {
        throw new TypeError("Expected a text-only tool response");
      }
      expect(result.startsWith(TOOL_RESPONSE_OPEN)).toBe(true);
      expect(result.endsWith(TOOL_RESPONSE_CLOSE)).toBe(true);
    }
  );

  it("creates a formatter with default options", () => {
    // Given
    const formatter = createQwen3CoderXmlToolResponseFormatter();
    const toolResult = {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "coverage_tool",
      output: { type: "text", value: "done" },
    } satisfies ToolResultPart;

    // When
    const result = formatter(toolResult);

    // Then
    expect(result).toBe(`${TOOL_RESPONSE_OPEN}\ndone\n${TOOL_RESPONSE_CLOSE}`);
  });
});
