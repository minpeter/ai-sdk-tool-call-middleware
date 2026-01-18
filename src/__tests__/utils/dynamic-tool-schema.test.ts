import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3ProviderTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { createDynamicIfThenElseSchema } from "../../core/utils/dynamic-tool-schema";

describe("createDynamicIfThenElseSchema", () => {
  it("should create schema for single tool", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "getTool",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
    ];

    const schema = createDynamicIfThenElseSchema(tools);

    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties?.name).toMatchObject({
      type: "string",
      description: "Name of the tool to call",
      enum: ["getTool"],
    });
    expect(schema.properties?.arguments).toMatchObject({
      type: "object",
      description: "Argument object to be passed to the tool",
    });
    expect(schema.required).toEqual(["name", "arguments"]);
    expect(schema.if).toBeDefined();
    expect(schema.then).toBeDefined();
  });

  it("should create nested if-then-else schema for multiple tools", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "tool1",
        inputSchema: {
          type: "object",
          properties: {
            arg1: { type: "string" },
          },
        },
      },
      {
        type: "function",
        name: "tool2",
        inputSchema: {
          type: "object",
          properties: {
            arg2: { type: "number" },
          },
        },
      },
      {
        type: "function",
        name: "tool3",
        inputSchema: {
          type: "object",
          properties: {
            arg3: { type: "boolean" },
          },
        },
      },
    ];

    const schema = createDynamicIfThenElseSchema(tools);

    expect(schema.type).toBe("object");
    expect(schema.properties?.name).toMatchObject({
      type: "string",
      enum: ["tool1", "tool2", "tool3"],
    });

    // Check nested structure
    expect(schema.if).toBeDefined();
    expect(schema.then).toBeDefined();
    expect(schema.else).toBeDefined();

    // Check first tool condition (last in array due to reverse loop)
    const firstCondition = schema.if as any;
    expect(firstCondition.properties.name.const).toBe("tool1");

    // Check nested else conditions
    const secondCondition = (schema.else as any).if;
    expect(secondCondition.properties.name.const).toBe("tool2");

    const thirdCondition = ((schema.else as any).else as any).if;
    expect(thirdCondition.properties.name.const).toBe("tool3");
  });

  it("should throw error for provider tools", () => {
    const tools = [
      {
        type: "provider" as const,
        id: "provider.tool" as const,
        name: "provider-tool",
        args: {} as Record<string, unknown>,
      } satisfies LanguageModelV3ProviderTool,
    ];

    expect(() => createDynamicIfThenElseSchema(tools)).toThrow(
      "Provider tools are not supported by this middleware"
    );
  });

  it("should handle empty tool array", () => {
    const tools: LanguageModelV3FunctionTool[] = [];

    const schema = createDynamicIfThenElseSchema(tools);

    expect(schema.type).toBe("object");
    expect(schema.properties?.name).toMatchObject({
      type: "string",
      enum: [],
    });
    expect(schema.required).toEqual(["name", "arguments"]);
  });

  it("should preserve tool input schemas correctly", () => {
    const complexSchema = {
      type: "object" as const,
      properties: {
        requiredField: { type: "string" as const },
        optionalField: { type: "number" as const },
        nestedObject: {
          type: "object" as const,
          properties: {
            nestedField: { type: "boolean" as const },
          },
        },
      },
      required: ["requiredField"],
    };

    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "complexTool",
        inputSchema: complexSchema,
      },
    ];

    const schema = createDynamicIfThenElseSchema(tools);

    const thenClause = schema.then as any;
    expect(thenClause.properties.arguments).toEqual(complexSchema);
  });

  it("should create schema with correct order for tools", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "alpha",
        inputSchema: { type: "object" },
      },
      {
        type: "function",
        name: "beta",
        inputSchema: { type: "object" },
      },
      {
        type: "function",
        name: "gamma",
        inputSchema: { type: "object" },
      },
    ];

    const schema = createDynamicIfThenElseSchema(tools);

    // Tools should be in the order provided
    expect(schema.properties?.name).toMatchObject({
      enum: ["alpha", "beta", "gamma"],
    });

    // The if-then-else chain should process tools in reverse order
    // (first tool first due to the loop implementation)
    const firstIf = schema.if as any;
    expect(firstIf.properties.name.const).toBe("alpha");
  });

  it("should handle tools with no input schema", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "noArgsTool",
        inputSchema: undefined as any, // Tool with no arguments
      },
    ];

    const schema = createDynamicIfThenElseSchema(tools);

    expect(schema).toBeDefined();
    expect(schema.then).toBeDefined();
    const thenClause = schema.then as any;
    expect(thenClause.properties.arguments).toBeUndefined();
  });

  it("should handle mixed tool types correctly", () => {
    const tools = [
      {
        type: "function" as const,
        name: "functionTool",
        inputSchema: { type: "object" },
      },
      {
        type: "provider" as const,
        id: "provider.tool" as const,
        name: "providerTool",
        args: {} as Record<string, unknown>,
      },
    ] as (LanguageModelV3FunctionTool | LanguageModelV3ProviderTool)[];

    expect(() => createDynamicIfThenElseSchema(tools)).toThrow(
      "Provider tools are not supported by this middleware"
    );
  });

  it("should create valid JSON Schema 7 structure", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "validateSchema",
        inputSchema: {
          type: "object",
          properties: {
            field: { type: "string" },
          },
        },
      },
    ];

    const schema = createDynamicIfThenElseSchema(tools);

    // Verify it's a valid JSONSchema7 structure
    expect(schema.type).toBe("object");
    expect(Array.isArray(schema.required)).toBe(true);
    expect(typeof schema.properties).toBe("object");
    expect(schema.if).toBeDefined();
    expect(schema.then).toBeDefined();
  });
});
