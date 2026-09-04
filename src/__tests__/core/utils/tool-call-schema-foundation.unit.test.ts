import { describe, expect, it } from "vitest";
import { getToolInputPropertyNames } from "../../../core/utils/tool-call-object-schema";
import { collectSchemaSelectionPropertyNames } from "../../../core/utils/tool-call-schema-property-names";
import { sanitizeToolCallArgsBySchema } from "../../../core/utils/tool-call-schema-sanitization";
import type {
  ToolInputSchema,
  ToolInputSchemaCandidate,
} from "../../../schema/tool-input-schema";
import { unwrapJsonSchema } from "../../../schema-coerce";

describe("tool-call schema foundation", () => {
  it("drops undeclared properties when sanitizing a strict object", () => {
    // Given
    const schema = {
      type: "object",
      properties: { kept: { type: "string" } },
      additionalProperties: false,
    } satisfies ToolInputSchema;
    const value = { kept: "value", dropped: "extra" };

    // When
    const sanitized = sanitizeToolCallArgsBySchema(value, schema);

    // Then
    expect(sanitized).toEqual({ kept: "value" });
  });

  it("sanitizes array items using the item schema", () => {
    // Given
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: { kept: { type: "string" } },
        additionalProperties: false,
      },
    } satisfies ToolInputSchema;
    const value = [{ kept: "value", dropped: "extra" }];

    // When
    const sanitized = sanitizeToolCallArgsBySchema(value, schema);

    // Then
    expect(sanitized).toEqual([{ kept: "value" }]);
  });

  it("sanitizes with the matching oneOf variant", () => {
    // Given
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: {
            kind: { const: "first" },
            firstValue: { type: "string" },
          },
          required: ["kind", "firstValue"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "second" },
            secondValue: { type: "string" },
          },
          required: ["kind", "secondValue"],
          additionalProperties: false,
        },
      ],
    } satisfies ToolInputSchema;
    const value = {
      kind: "second",
      secondValue: "value",
      dropped: "extra",
    };

    // When
    const sanitized = sanitizeToolCallArgsBySchema(value, schema);

    // Then
    expect(sanitized).toEqual({ kind: "second", secondValue: "value" });
  });

  it("collects declared and required tool input property names", () => {
    // Given
    const schema = {
      type: "object",
      properties: { declared: { type: "string" } },
      required: ["declared", "requiredOnly"],
    } satisfies ToolInputSchema;

    // When
    const names = getToolInputPropertyNames(schema, {});

    // Then
    expect(names).toEqual(new Set(["declared", "requiredOnly"]));
  });

  it("returns the input by identity for a malformed schema", () => {
    // Given
    const malformedSchema: ToolInputSchemaCandidate = "malformed";
    const value = { untouched: true };

    // When
    const schema = unwrapJsonSchema(malformedSchema);
    const sanitized =
      schema === undefined
        ? value
        : sanitizeToolCallArgsBySchema(value, schema);

    // Then
    expect(sanitized).toBe(value);
  });

  it("retains prototype-sensitive schema selection property names", () => {
    // Given
    const schema = {
      properties: {
        ["__proto__"]: true,
        constructor: true,
        prototype: true,
      },
    } satisfies ToolInputSchema;

    // When
    const names = collectSchemaSelectionPropertyNames(schema);

    // Then
    expect(names).toEqual(new Set(["__proto__", "constructor", "prototype"]));
  });
});
