import { describe, expect, it } from "vitest";
import {
  hasPrototypeSensitiveStructuralKey,
  toolCallInputHasPrototypeSensitiveKey,
} from "../../../core/utils/prototype-sensitive-keys";
import { getArrayItemSchema } from "../../../core/utils/tool-call-array-schema";
import { getDeclaredPropertySchema } from "../../../core/utils/tool-call-object-property-schema";
import {
  collectPatternPropertyNames,
  getPatternPropertySchema,
  hasDeclaredPatternProperties,
  hasUnsafeFalsePatternProperties,
  unsafeFalsePatternMayMatchKey,
} from "../../../core/utils/tool-call-pattern-properties";
import { toolCallInputHasSchemaAwarePrototypeSensitiveValue } from "../../../core/utils/tool-call-schema-aware-prototype";
import type { RxmlValue } from "../../../rxml/builders/stringify";
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

  it("detects unsafe false patterns and filters impossible key matches", () => {
    // Given
    const unsafeSchema = {
      patternProperties: {
        "^(q+)+$": true,
        "^(z+)+$": false,
        "^(a+)+$": false,
      },
    } satisfies ToolInputSchema;
    const safeSchema = {
      patternProperties: { "^x-": false },
    } satisfies ToolInputSchema;

    // When
    const absentDecisions = [false, true, {}].map((schema) => ({
      declared: hasDeclaredPatternProperties(schema),
      unsafe: hasUnsafeFalsePatternProperties(schema),
      mayMatch: unsafeFalsePatternMayMatchKey(schema, "aaa"),
    }));
    const unsafeDecisions = {
      declared: hasDeclaredPatternProperties(unsafeSchema),
      unsafe: hasUnsafeFalsePatternProperties(unsafeSchema),
      matching: unsafeFalsePatternMayMatchKey(unsafeSchema, "aaa"),
      allowedPattern: unsafeFalsePatternMayMatchKey(unsafeSchema, "qqq"),
      unrelated: unsafeFalsePatternMayMatchKey(unsafeSchema, "bbb"),
    };

    // Then
    expect(absentDecisions).toEqual([
      { declared: false, unsafe: false, mayMatch: false },
      { declared: false, unsafe: false, mayMatch: false },
      { declared: false, unsafe: false, mayMatch: false },
    ]);
    expect(hasUnsafeFalsePatternProperties(safeSchema)).toBe(false);
    expect(unsafeDecisions).toEqual({
      declared: true,
      unsafe: true,
      matching: true,
      allowedPattern: false,
      unrelated: false,
    });
  });

  it("guards pattern collection and resolution at schema and value boundaries", () => {
    // Given
    const schema = {
      patternProperties: {
        "^safe-": { type: "string" },
        "-label$": false,
      },
    } satisfies ToolInputSchema;

    // When
    const malformedNames = collectPatternPropertyNames(false, { key: 1 });
    const primitiveNames = collectPatternPropertyNames(schema, "safe-label");
    const matchingNames = collectPatternPropertyNames(schema, {
      "safe-value": "ok",
      other: "ignored",
    });
    const malformedSchema = getPatternPropertySchema(false, "safe-label");
    const sensitiveKey = getPatternPropertySchema(schema, "__proto__");
    const deniedSchema = getPatternPropertySchema(schema, "safe-label");

    // Then
    expect(malformedNames).toEqual(new Set());
    expect(primitiveNames).toEqual(new Set());
    expect(matchingNames).toEqual(new Set(["safe-value"]));
    expect(malformedSchema).toBeUndefined();
    expect(sensitiveKey).toBeUndefined();
    expect(deniedSchema).toBe(false);
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

  it("applies structured-string checks only to argument values", () => {
    // Given structured string leaves whose decoded keys are unsafe.
    const values = [
      '{"constructor":{}}',
      "<prototype>true</prototype>",
      "constructor:\n  polluted: true",
    ];

    // When structural and argument traversal inspect each value.
    const decisions = values.map((value) => ({
      structural: hasPrototypeSensitiveStructuralKey({ payload: value }),
      argument: toolCallInputHasPrototypeSensitiveKey({ payload: value }),
    }));

    // Then only argument traversal interprets string contents.
    expect(decisions).toEqual([
      { structural: false, argument: true },
      { structural: false, argument: true },
      { structural: false, argument: true },
    ]);
  });

  it("terminates cyclic object and array traversal without inventing sensitivity", () => {
    // Given safe self-referential object and array values.
    const object: { self?: RxmlValue } = {};
    object.self = object;
    const array: RxmlValue[] = [];
    array.push(array);

    // When both traversal policies inspect each cycle.
    const decisions = [object, array].map((value) => ({
      structural: hasPrototypeSensitiveStructuralKey(value),
      argument: toolCallInputHasPrototypeSensitiveKey(value),
    }));

    // Then revisiting a container terminates without changing its safety result.
    expect(decisions).toEqual([
      { structural: false, argument: false },
      { structural: false, argument: false },
    ]);
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
