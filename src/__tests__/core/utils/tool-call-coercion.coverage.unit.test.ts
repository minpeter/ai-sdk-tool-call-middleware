import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  coerceToolCallInput,
  coerceToolCallPart,
} from "../../../core/utils/tool-call-coercion";
import type { RxmlValue } from "../../../rxml/builders/stringify";
import type { ToolInputSchema } from "../../../schema/tool-input-schema";

function toolsWithSchema(
  inputSchema: ToolInputSchema
): LanguageModelV4FunctionTool[] {
  return [{ type: "function", name: "target", inputSchema }];
}

describe("coerceToolCallInput boundary coverage", () => {
  it.each([
    [true, "true"],
    [42, "42"],
    ['"plain"', '"plain"'],
    [{ optional: undefined }, "{}"],
  ])("serializes native JSON-compatible input %#", (input, expected) => {
    // Given: schema-free input from a provider.
    const tools: LanguageModelV4FunctionTool[] = [];

    // When: the input is coerced.
    const result = coerceToolCallInput("missing", input, tools);

    // Then: its JSON representation is returned.
    expect(result).toBe(expected);
  });

  it.each([undefined, [undefined]] satisfies readonly RxmlValue[])(
    "rejects native non-JSON input %#",
    (input) => {
      // Given: a value outside the provider JSON boundary.
      const tools: LanguageModelV4FunctionTool[] = [];

      // When: the input is coerced.
      const result = coerceToolCallInput("missing", input, tools);

      // Then: invalid input is rejected.
      expect(result).toBeUndefined();
    }
  );

  it("rejects cyclic native input", () => {
    // Given: a self-referential provider object.
    const input: { self?: RxmlValue } = {};
    input.self = input;

    // When: the input is coerced.
    const result = coerceToolCallInput("missing", input, []);

    // Then: the cycle is rejected.
    expect(result).toBeUndefined();
  });

  it("uses empty arguments when coercion produces a non-JSON array", () => {
    // Given: object input that becomes an array containing undefined.
    const input = { item: undefined };
    const tools = toolsWithSchema({
      type: "array",
      items: { type: "string" },
    });

    // When: the input is coerced.
    const result = coerceToolCallInput("target", input, tools);

    // Then: the invalid intermediate value is replaced safely.
    expect(result).toBe("{}");
  });

  it("sanitizes a valid value with the matching schema", () => {
    // Given: an object with one declared and one undeclared property.
    const tools = toolsWithSchema({
      type: "object",
      properties: { kept: { type: "number" } },
      additionalProperties: false,
    });

    // When: the input is coerced and sanitized.
    const result = coerceToolCallInput(
      "target",
      { kept: "2", dropped: true },
      tools
    );

    // Then: only the declared coerced property remains.
    expect(result).toBe('{"kept":2}');
  });

  it("rejects prototype-sensitive values before coercion", () => {
    // Given: a schema-valid property containing unsafe structured text.
    const tools = toolsWithSchema({
      type: "object",
      properties: { payload: { type: "string" } },
    });

    // When: the input is coerced.
    const result = coerceToolCallInput(
      "target",
      { payload: "<prototype>true</prototype>" },
      tools
    );

    // Then: the unsafe value is rejected.
    expect(result).toBeUndefined();
  });

  it("rejects a value that becomes prototype-sensitive during coercion", () => {
    // Given: a provider getter that changes after the initial safety passes.
    let reads = 0;
    const input: { readonly payload: RxmlValue } = {
      get payload(): RxmlValue {
        reads += 1;
        return reads < 4 ? "safe" : "<prototype>true</prototype>";
      },
    };

    // When: the value changes before final serialization.
    const result = coerceToolCallInput("missing", input, []);

    // Then: the final safety boundary rejects the changed value.
    expect(result).toBeUndefined();
  });

  it("returns undefined for a JSON serializer TypeError", () => {
    // Given: the platform serializer rejects a valid boundary value.
    vi.spyOn(JSON, "stringify").mockImplementationOnce(() => {
      throw new TypeError("serializer rejected value");
    });

    // When: the value reaches serialization.
    const result = coerceToolCallInput("missing", 1, []);

    // Then: the expected serializer failure is normalized.
    expect(result).toBeUndefined();
  });

  it("rethrows unexpected JSON serializer failures", () => {
    // Given: the platform serializer raises an unexpected error.
    const failure = new RangeError("serializer failure");
    vi.spyOn(JSON, "stringify").mockImplementationOnce(() => {
      throw failure;
    });

    // When: the value reaches serialization.
    const action = () => coerceToolCallInput("missing", 1, []);

    // Then: the same unexpected error escapes.
    expect(action).toThrow(failure);
  });

  it("rethrows unexpected JSON parser failures", () => {
    // Given: the platform parser raises an unexpected error.
    const failure = new RangeError("parser failure");
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw failure;
    });

    // When: string input reaches parsing.
    const action = () => coerceToolCallInput("missing", "{}", []);

    // Then: the same unexpected error escapes.
    expect(action).toThrow(failure);
  });
});

describe("coerceToolCallInput null-schema coverage", () => {
  it.each([
    [{ jsonSchema: true }, "null"],
    [{ jsonSchema: false }, undefined],
    [{ type: "null" }, "null"],
    [{ type: ["string", "null"] }, "null"],
    [{ allOf: [{ type: "null" }, true] }, "null"],
    [{ allOf: [{ type: "null" }, { type: "string" }] }, undefined],
    [{ anyOf: [{ type: "string" }, { type: "null" }] }, "null"],
    [{ anyOf: [{ type: "string" }] }, undefined],
    [{ oneOf: [{ type: "null" }] }, "null"],
    [{ oneOf: [{ type: "string" }] }, undefined],
    [{}, undefined],
  ] satisfies readonly (readonly [ToolInputSchema, string | undefined])[])(
    "handles nullable schema %#",
    (schema, expected) => {
      // Given: null and a schema with known nullability.
      const tools = toolsWithSchema(schema);

      // When: null is coerced.
      const result = coerceToolCallInput("target", null, tools);

      // Then: the schema determines whether null is retained.
      expect(result).toBe(expected);
    }
  );

  it.each([
    [{ type: "number" }, undefined],
    [{ type: ["number", "null"] }, "null"],
  ] satisfies readonly (readonly [ToolInputSchema, string | undefined])[])(
    "handles parsed null with schema %#",
    (schema, expected) => {
      // Given: serialized null and a schema with known nullability.
      const tools = toolsWithSchema(schema);

      // When: null crosses the string input boundary.
      const result = coerceToolCallInput("target", "null", tools);

      // Then: schema nullability determines the result.
      expect(result).toBe(expected);
    }
  );

  it("rejects recursive nullable schema traversal", () => {
    // Given: a combinator schema that references itself.
    const schema: ToolInputSchema = {};
    schema.oneOf = [schema];

    // When: null is coerced.
    const result = coerceToolCallInput("target", null, toolsWithSchema(schema));

    // Then: the recursive path does not claim nullability.
    expect(result).toBeUndefined();
  });
});

describe("coerceToolCallPart coverage", () => {
  it("preserves invalid ordinary string input", () => {
    // Given: a tool call with malformed JSON input.
    const part = {
      type: "tool-call" as const,
      toolCallId: "call-1",
      toolName: "target",
      input: "invalid",
    };

    // When: the complete part is coerced.
    const result = coerceToolCallPart(part, []);

    // Then: the original part identity is retained.
    expect(result).toBe(part);
  });

  it("replaces prototype-sensitive string input with empty arguments", () => {
    // Given: a tool call containing a prototype-sensitive JSON key.
    const part = {
      type: "tool-call" as const,
      toolCallId: "call-1",
      toolName: "target",
      input: '{"constructor":{"polluted":true}}',
    };

    // When: the complete part is coerced.
    const result = coerceToolCallPart(part, []);

    // Then: the unsafe input is replaced.
    expect(result).toEqual({ ...part, input: "{}" });
  });

  it("returns a new part when coercion succeeds", () => {
    // Given: a tool call containing valid JSON input.
    const part = {
      type: "tool-call" as const,
      toolCallId: "call-1",
      toolName: "target",
      input: "1",
    };

    // When: the complete part is coerced.
    const result = coerceToolCallPart(part, []);

    // Then: the serialized input is returned on a new part.
    expect(result).toEqual({ ...part, input: "1" });
  });
});
