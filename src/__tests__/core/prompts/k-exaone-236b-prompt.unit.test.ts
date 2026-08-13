import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { kExaone236BToolDeclaration } from "../../../core/prompts/k-exaone-236b-prompt";

describe("kExaone236BToolDeclaration", () => {
  it("matches the Friendli native declaration bytes", () => {
    // Given
    const tools = [
      {
        type: "function",
        name: "edge_probe",
        description: "Probe exact JSON rendering.",
        inputSchema: {
          type: "object",
          properties: {
            zed: { type: "number", minimum: 1e-7, maximum: 1e21 },
            alpha: { type: "integer" },
            raw: { type: "string" },
          },
          required: ["zed"],
          additionalProperties: false,
        },
        strict: true,
        inputExamples: [{ input: { zed: 1 } }],
      },
    ] satisfies LanguageModelV4FunctionTool[];

    // When
    const declaration = kExaone236BToolDeclaration(tools);

    // Then
    expect(declaration).toBe(
      '# Tools\n<tool>{"type": "function", "function": {"name": "edge_probe", "description": "Probe exact JSON rendering.", "parameters": {"additionalProperties": false, "properties": {"alpha": {"type": "integer"}, "raw": {"type": "string"}, "zed": {"maximum": 1e+21, "minimum": 1e-07, "type": "number"}}, "required": ["zed"], "type": "object"}}}</tool>\n'
    );
  });

  it("returns an empty declaration when no tools exist", () => {
    // Given
    const tools: LanguageModelV4FunctionTool[] = [];

    // When
    const declaration = kExaone236BToolDeclaration(tools);

    // Then
    expect(declaration).toBe("");
  });

  it("renders multiple tools without an undefined description", () => {
    const tools = [
      {
        type: "function",
        name: "first",
        inputSchema:
          '{"type":"object","properties":{"value":{"type":"string"}}}' as unknown as LanguageModelV4FunctionTool["inputSchema"],
      },
      {
        type: "function",
        name: "second",
        description: "Second tool.",
        inputSchema: { type: "object" },
      },
    ] satisfies LanguageModelV4FunctionTool[];

    expect(kExaone236BToolDeclaration(tools)).toBe(
      '# Tools\n<tool>{"type": "function", "function": {"name": "first", "parameters": {"properties": {"value": {"type": "string"}}, "type": "object"}}}</tool>\n<tool>{"type": "function", "function": {"name": "second", "description": "Second tool.", "parameters": {"type": "object"}}}</tool>\n'
    );
  });
});
