import { describe, expect, it } from "vitest";
import { hasPrototypeSensitiveStructuralKey } from "../../../core/utils/prototype-sensitive-keys";
import { getArrayItemSchema } from "../../../core/utils/tool-call-array-schema";
import { getDeclaredPropertySchema } from "../../../core/utils/tool-call-object-property-schema";
import { getPatternPropertySchema } from "../../../core/utils/tool-call-pattern-properties";
import { toolCallInputHasSchemaAwarePrototypeSensitiveValue } from "../../../core/utils/tool-call-schema-aware-prototype";
import type {
  ToolInputSchema,
  ToolInputSchemaCandidate,
} from "../../../schema/tool-input-schema";
import { unwrapJsonSchema } from "../../../schema-coerce";

describe("tool-call schema safety", () => {
  it("rejects a nested structured prototype-sensitive key", () => {
    // Given
    const value = { metadata: { constructor: { polluted: true } } };
    const schema = {
      type: "object",
      additionalProperties: true,
    } satisfies ToolInputSchema;

    // When
    const sensitive = toolCallInputHasSchemaAwarePrototypeSensitiveValue(
      value,
      schema
    );

    // Then
    expect(sensitive).toBe(true);
  });

  it("accepts a safe structured string leaf when its schema is string", () => {
    // Given
    const value = { label: '{"constructor":"ordinary"}' };
    const schema = {
      type: "object",
      properties: { label: { type: "string" } },
    } satisfies ToolInputSchema;

    // When
    const sensitive = toolCallInputHasSchemaAwarePrototypeSensitiveValue(
      value,
      schema
    );

    // Then
    expect(sensitive).toBe(false);
  });

  it("uses tuple prefixItems and a nested object property schema", () => {
    // Given
    const value = [{ label: '{"constructor":"ordinary"}' }];
    const schema = {
      type: "array",
      prefixItems: [
        {
          type: "object",
          properties: { label: { type: "string" } },
        },
      ],
    } satisfies ToolInputSchema;

    // When
    const sensitive = toolCallInputHasSchemaAwarePrototypeSensitiveValue(
      value,
      schema
    );

    // Then
    expect(sensitive).toBe(false);
  });

  it("applies matching patternProperties without applying nonmatches", () => {
    // Given
    const schema = {
      type: "object",
      patternProperties: { "^safe-": { type: "string" } },
    } satisfies ToolInputSchema;
    const safeValue = { "safe-label": '{"constructor":"ordinary"}' };
    const unsafeValue = { label: '{"constructor":"ordinary"}' };

    // When
    const matchingSensitive =
      toolCallInputHasSchemaAwarePrototypeSensitiveValue(safeValue, schema);
    const nonmatchingSensitive =
      toolCallInputHasSchemaAwarePrototypeSensitiveValue(unsafeValue, schema);

    // Then
    expect(matchingSensitive).toBe(false);
    expect(nonmatchingSensitive).toBe(true);
  });

  it("combines multiple matching pattern schemas with allOf", () => {
    // Given
    const schema = {
      patternProperties: {
        "^safe-": { type: "string" },
        label$: { minLength: 1 },
      },
    } satisfies ToolInputSchema;

    // When
    const propertySchema = getPatternPropertySchema(schema, "safe-label");

    // Then
    expect(propertySchema).toEqual({
      allOf: [{ type: "string" }, { minLength: 1 }],
    });
  });

  it("preserves false schemas for object and array resolution", () => {
    // Given
    const objectSchema = {
      properties: { denied: false },
    } satisfies ToolInputSchema;
    const arraySchema = { items: false } satisfies ToolInputSchema;

    // When
    const propertySchema = getDeclaredPropertySchema(
      objectSchema,
      "denied",
      "value",
      new Set()
    );
    const itemSchema = getArrayItemSchema(arraySchema, 0);

    // Then
    expect(propertySchema).toBe(false);
    expect(itemSchema).toBe(false);
  });

  it("handles malformed schemas without marking safe input as sensitive", () => {
    // Given
    const malformedSchema: ToolInputSchemaCandidate = "not-a-schema";
    const value = { label: "ordinary text" };

    // When
    const schema = unwrapJsonSchema(malformedSchema);
    const itemSchema =
      schema === undefined ? undefined : getArrayItemSchema(schema, 0);
    const sensitive = toolCallInputHasSchemaAwarePrototypeSensitiveValue(
      value,
      schema
    );

    // Then
    expect(itemSchema).toBeUndefined();
    expect(sensitive).toBe(false);
  });

  it("rejects input with a nonstandard prototype", () => {
    // Given
    const value = { label: "ordinary text" };
    Object.setPrototypeOf(value, { polluted: true });

    // When
    const sensitive = hasPrototypeSensitiveStructuralKey(value);

    // Then
    expect(sensitive).toBe(true);
  });
});
