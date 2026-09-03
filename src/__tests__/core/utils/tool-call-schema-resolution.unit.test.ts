import { describe, expect, it } from "vitest";

import { getArrayItemSchema } from "../../../core/utils/tool-call-array-schema";
import { getDeclaredPropertySchema } from "../../../core/utils/tool-call-object-property-schema";
import {
  collectPatternPropertyNames,
  getPatternPropertySchema,
} from "../../../core/utils/tool-call-pattern-properties";

describe("tool-call schema resolution", () => {
  it("selects prefixItems before homogeneous items by index", () => {
    // Given
    const schema = {
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    };

    // When
    const prefixSchema = getArrayItemSchema(schema, 0);
    const homogeneousSchema = getArrayItemSchema(schema, 1);

    // Then
    expect(prefixSchema).toEqual({ type: "string" });
    expect(homogeneousSchema).toEqual({ type: "number" });
  });

  it("combines array item schemas from allOf", () => {
    // Given
    const schema = {
      allOf: [{ items: { type: "string" } }, { items: { minLength: 1 } }],
    };

    // When
    const itemSchema = getArrayItemSchema(schema, 0);

    // Then
    expect(itemSchema).toEqual({
      allOf: [{ type: "string" }, { minLength: 1 }],
    });
  });

  it("combines direct and allOf object property schemas", () => {
    // Given
    const schema = {
      properties: { label: { type: "string" } },
      allOf: [{ properties: { label: { minLength: 1 } } }],
    };

    // When
    const propertySchema = getDeclaredPropertySchema(
      schema,
      "label",
      "value",
      new Set()
    );

    // Then
    expect(propertySchema).toEqual({
      allOf: [{ type: "string" }, { minLength: 1 }],
    });
  });

  it("resolves a property from the selected anyOf branch", () => {
    // Given
    const schema = {
      anyOf: [
        {
          properties: {
            kind: { const: "first" },
            firstValue: { type: "string" },
          },
          required: ["kind", "firstValue"],
        },
        {
          properties: {
            kind: { const: "second" },
            secondValue: { type: "number" },
          },
          required: ["kind", "secondValue"],
        },
      ],
    };
    const value = { kind: "second", secondValue: 2 };

    // When
    const propertySchema = getDeclaredPropertySchema(
      schema,
      "secondValue",
      value,
      new Set()
    );

    // Then
    expect(propertySchema).toEqual({ type: "number" });
  });

  it("collects property names that match declared patterns", () => {
    // Given
    const schema = {
      patternProperties: {
        "^x-": { type: "string" },
        "-count$": { type: "number" },
      },
    };
    const value = { "x-label": "ok", "item-count": 2, other: true };

    // When
    const names = collectPatternPropertyNames(schema, value);

    // Then
    expect(names).toEqual(new Set(["x-label", "item-count"]));
  });

  it("combines multiple matching pattern property schemas", () => {
    // Given
    const schema = {
      patternProperties: {
        "^x-": { type: "string" },
        "-label$": { minLength: 1 },
      },
    };

    // When
    const propertySchema = getPatternPropertySchema(schema, "x-label");

    // Then
    expect(propertySchema).toEqual({
      allOf: [{ type: "string" }, { minLength: 1 }],
    });
  });

  it("preserves false schemas across array object and pattern resolution", () => {
    // Given
    const arraySchema = { items: false };
    const objectSchema = { properties: { denied: false } };
    const patternSchema = { patternProperties: { "^denied$": false } };

    // When
    const item = getArrayItemSchema(arraySchema, 0);
    const property = getDeclaredPropertySchema(
      objectSchema,
      "denied",
      "value",
      new Set()
    );
    const pattern = getPatternPropertySchema(patternSchema, "denied");

    // Then
    expect(item).toBe(false);
    expect(property).toBe(false);
    expect(pattern).toBe(false);
  });

  it("returns undefined for malformed schema inputs", () => {
    // Given
    const malformedSchema = "not-a-schema";

    // When
    const item = getArrayItemSchema(malformedSchema, 0);
    const property = getDeclaredPropertySchema(
      malformedSchema,
      "label",
      "value",
      new Set()
    );

    // Then
    expect(item).toBeUndefined();
    expect(property).toBeUndefined();
  });
});
