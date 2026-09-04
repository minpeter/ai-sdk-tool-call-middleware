import type {
  JSONObject,
  JSONValue,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import {
  morphFormatToolResponseAsXml,
  morphXmlSystemPromptTemplate,
} from "../../../core/prompts/morph-xml-prompt";
import type {
  ToolInputSchema,
  ToolInputSchemaCandidate,
  ToolInputSchemaDefinition,
} from "../../../schema/tool-input-schema";

describe("morphXmlSystemPromptTemplate schema rendering", () => {
  it("renders no tool definitions when the tool list is empty", () => {
    const prompt = morphXmlSystemPromptTemplate([]);

    expect(prompt).toContain("<tools>\nnone\n</tools>");
  });

  it("normalizes serialized, boolean, absent, and malformed schemas", () => {
    const schemas: ToolInputSchemaCandidate[] = [
      '{"type":"object","properties":{"id":{"type":"number"}}}',
      '"literal"',
      "not-json",
      true,
      false,
      undefined,
      null,
    ];
    const tools = schemas.map((schema, index) => {
      const tool: LanguageModelV4FunctionTool = {
        type: "function",
        name: `schema_${index}`,
        inputSchema: {} satisfies ToolInputSchema,
      };
      Object.defineProperty(tool, "inputSchema", {
        configurable: true,
        enumerable: true,
        value: schema,
      });
      return tool;
    });
    const scalarSchemaTool: LanguageModelV4FunctionTool = {
      type: "function",
      name: "runtime_scalar_schema",
      inputSchema: {},
    };
    Object.defineProperty(scalarSchemaTool, "inputSchema", {
      configurable: true,
      enumerable: true,
      value: 17,
    });

    const prompt = morphXmlSystemPromptTemplate([...tools, scalarSchemaTool]);

    expect(prompt).toContain("- id (number, optional)");
    expect(prompt).toContain(
      String.raw`schema: {"type":"string","const":"\"literal\""}`
    );
    expect(prompt).toContain('schema: {"type":"string","const":"not-json"}');
    expect(prompt).toContain("  (any)");
    expect(prompt).toContain("  (no valid parameters)");
    expect(prompt).toContain("  (none)");
    expect(prompt).toContain("  - value (17)");
    expect(prompt).toContain("schema: null");
  });

  it("summarizes all schema type and metadata forms", () => {
    const properties: Record<string, ToolInputSchemaDefinition> = {
      any_value: true,
      array_without_items: { type: "array" },
      const_value: { const: 9 },
      default_values: {
        default: [null, true, { nested: "value" }],
      },
      empty_type_array: { type: [] },
      formatted: { type: "string", format: "date-time" },
      mixed_enum: { enum: ["one", 2] },
      never_value: false,
      required_value: { type: ["string", "null"] },
      single_enum: { enum: [1, 2, 3] },
      tuple: { type: "array", items: [{ type: "string" }, false] },
      typed_array: { type: "array", items: { type: "boolean" } },
      verbose_enum: {
        enum: ["a", "b", "c", "d", "e", "f", "g"],
        description: "Seven choices",
      },
    };
    Object.defineProperty(properties, "absent", {
      enumerable: true,
      value: undefined,
    });
    const tool: LanguageModelV4FunctionTool = {
      type: "function",
      name: "schema_matrix",
      description: "Schema matrix",
      inputSchema: {
        type: ["object", "null"],
        required: ["required_value"],
        properties,
      },
    };

    const prompt = morphXmlSystemPromptTemplate([tool]);

    expect(prompt).toContain("- absent (unknown, optional)");
    expect(prompt).toContain("- any_value (any, optional)");
    expect(prompt).toContain("- array_without_items (array, optional)");
    expect(prompt).toContain("- const_value (number, optional)");
    expect(prompt).toContain(
      '- default_values (any, optional) - default: [null, true, {"nested":"value"}]'
    );
    expect(prompt).toContain("- empty_type_array (any, optional)");
    expect(prompt).toContain("- formatted (string (date-time), optional)");
    expect(prompt).toContain('- mixed_enum (any, optional) - enum: ["one", 2]');
    expect(prompt).toContain("- never_value (never, optional)");
    expect(prompt).toContain("- required_value (string | null, required)");
    expect(prompt).toContain(
      "- single_enum (number, optional) - enum: [1, 2, 3]"
    );
    expect(prompt).toContain("- tuple (array<string | never>, optional)");
    expect(prompt).toContain("- typed_array (array<boolean>, optional)");
    expect(prompt).toContain(
      '- verbose_enum (string, optional) - enum: ["a", "b", "c", "d", "e", ... (7 total)]; Seven choices'
    );
  });

  it("renders object-like schemas without named properties", () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "empty_object",
        inputSchema: { type: "object" },
      },
      {
        type: "function",
        name: "properties_imply_object",
        inputSchema: { properties: {} },
      },
    ];

    const prompt = morphXmlSystemPromptTemplate(tools);

    expect(prompt.match(/\(no named parameters\)/g)).toHaveLength(2);
  });

  it("removes schema metadata recursively without mutating array structure", () => {
    const tool: LanguageModelV4FunctionTool = {
      type: "function",
      name: "clean_schema",
      inputSchema: {
        $schema: "https://json-schema.org/draft-07/schema",
        type: "array",
        items: [
          {
            $schema: "nested",
            type: "object",
            properties: { value: { type: "string" } },
          },
          true,
        ],
      },
    };

    const prompt = morphXmlSystemPromptTemplate([tool]);

    expect(prompt).toContain(
      'schema: {"type":"array","items":[{"type":"object","properties":{"value":{"type":"string"}}},true]}'
    );
    expect(prompt).not.toContain("$schema");
  });

  it("falls back safely when a valid example becomes unreadable during XML serialization", () => {
    const input: JSONObject = {};
    let reads = 0;
    Object.defineProperty(input, "unstable", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads === 2) {
          throw new TypeError("second read failed & escaped");
        }
        return "stable";
      },
    });
    const tool: LanguageModelV4FunctionTool = {
      type: "function",
      name: "unstable_example",
      inputSchema: { type: "object" },
      inputExamples: [{ input }],
    };

    const prompt = morphXmlSystemPromptTemplate([tool]);

    expect(prompt).toContain(
      '<unstable_example>{"unstable":"stable"}</unstable_example>'
    );
  });

  it("serializes non-JSON example input through the escaped fallback", () => {
    const tool: LanguageModelV4FunctionTool = {
      type: "function",
      name: "invalid_example",
      inputSchema: { type: "object" },
      inputExamples: [{ input: {} }],
    };
    Object.defineProperty(tool.inputExamples?.[0], "input", {
      enumerable: true,
      value: Symbol("unsafe & value"),
    });

    const prompt = morphXmlSystemPromptTemplate([tool]);

    expect(prompt).toContain("<invalid_example>null</invalid_example>");
  });
});

describe("morphFormatToolResponseAsXml recursive serialization", () => {
  it.each([
    [null, "<result></result>"],
    [0, "<result>0</result>"],
    [false, "<result>false</result>"],
    [[], "<result></result>"],
    [[null, true, [], {}], "<item></item>"],
    [{}, "<result></result>"],
  ] satisfies [JSONValue, string][])(
    "serializes JSON shape %# without losing its scalar semantics",
    (value, expectedFragment) => {
      const result = morphFormatToolResponseAsXml({
        type: "tool-result",
        toolCallId: "shape",
        toolName: "shape",
        output: { type: "json", value },
      } satisfies ToolResultPart);

      expect(result).toContain(expectedFragment);
    }
  );

  it("serializes undefined nested values as empty nodes", () => {
    const value: JSONObject = { present: "yes" };
    Object.defineProperty(value, "missing", {
      enumerable: true,
      value: undefined,
    });

    const result = morphFormatToolResponseAsXml({
      type: "tool-result",
      toolCallId: "undefined",
      toolName: "undefined",
      output: { type: "json", value },
    } satisfies ToolResultPart);

    expect(result).toContain("<missing></missing>");
  });

  it("serializes only own enumerable object properties", () => {
    const value: JSONObject = { own: "visible" };
    Object.setPrototypeOf(value, { inherited: "hidden" });

    const result = morphFormatToolResponseAsXml({
      type: "tool-result",
      toolCallId: "prototype",
      toolName: "prototype",
      output: { type: "json", value },
    } satisfies ToolResultPart);

    expect(result).toContain("<own>visible</own>");
    expect(result).not.toContain("inherited");
  });
});
