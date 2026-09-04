import { describe, expect, it } from "vitest";
import { selectSchemaVariant } from "../../../core/utils/tool-call-schema-variant";
import type { RxmlValue } from "../../../rxml/builders/stringify";
import type { ToolInputSchema } from "../../../schema/tool-input-schema";

describe("tool-call schema variant selection coverage", () => {
  it("returns undefined when variants are absent or empty", () => {
    // Given
    const seen = new Set<object>();

    // When
    const absent = selectSchemaVariant(undefined, "value", seen);
    const empty = selectSchemaVariant([], "value", seen);

    // Then
    expect(absent).toBeUndefined();
    expect(empty).toBeUndefined();
  });

  it.each<readonly [ToolInputSchema["type"], RxmlValue]>([
    ["object", { key: "value" }],
    ["array", ["value"]],
    ["string", "value"],
    ["number", 1.5],
    ["integer", 1],
    ["boolean", true],
    ["null", null],
  ])("selects a matching %s schema", (type, value) => {
    // Given
    const schema = { type } satisfies ToolInputSchema;

    // When
    const selected = selectSchemaVariant([schema, true], value, new Set());

    // Then
    expect(selected).toBe(schema);
  });

  it.each<readonly [ToolInputSchema["type"], RxmlValue]>([
    ["object", []],
    ["array", { key: "value" }],
    ["string", 1],
    ["number", Number.POSITIVE_INFINITY],
    ["integer", 1.5],
    ["boolean", "true"],
    ["null", undefined],
  ])("rejects a nonmatching %s schema", (type, value) => {
    // Given
    const schema = { type } satisfies ToolInputSchema;

    // When
    const selected = selectSchemaVariant([schema, true], value, new Set());

    // Then
    expect(selected).toBe(true);
  });

  it("matches union types and unconstrained schemas", () => {
    // Given
    const union = { type: ["string", "number"] } satisfies ToolInputSchema;
    const unconstrained = {} satisfies ToolInputSchema;

    // When
    const selectedUnion = selectSchemaVariant([union, true], 2, new Set());
    const rejectedUnion = selectSchemaVariant([union, true], false, new Set());
    const selectedUnconstrained = selectSchemaVariant(
      [unconstrained, true],
      "value",
      new Set()
    );

    // Then
    expect(selectedUnion).toBe(union);
    expect(rejectedUnion).toBe(true);
    expect(selectedUnconstrained).toBe(unconstrained);
  });

  it("compares primitive array and object const values structurally", () => {
    // Given
    const primitive = { const: "expected" } satisfies ToolInputSchema;
    const array = { const: [1, { nested: true }] } satisfies ToolInputSchema;
    const object = {
      const: { first: 1, second: ["value"] },
    } satisfies ToolInputSchema;

    // When
    const primitiveMatch = selectSchemaVariant(
      [primitive, true],
      "expected",
      new Set()
    );
    const primitiveMismatch = selectSchemaVariant(
      [primitive, true],
      "other",
      new Set()
    );
    const arrayMatch = selectSchemaVariant(
      [array, true],
      [1, { nested: true }],
      new Set()
    );
    const objectMatch = selectSchemaVariant(
      [object, true],
      { second: ["value"], first: 1 },
      new Set()
    );

    // Then
    expect(primitiveMatch).toBe(primitive);
    expect(primitiveMismatch).toBe(true);
    expect(arrayMatch).toBe(array);
    expect(objectMatch).toBe(object);
  });

  it.each([
    [[1], [1, 2]],
    [[1], { 0: 1 }],
    [{ 0: 1 }, [1]],
    [{ first: 1 }, { second: 1 }],
    [{ first: 1 }, { first: 2 }],
    [{ first: 1 }, "primitive"],
    [{ first: null }, { first: {} }],
  ])("rejects unequal structured const values", (expected, value) => {
    // Given
    const schema = { const: expected } satisfies ToolInputSchema;

    // When
    const selected = selectSchemaVariant([schema, true], value, new Set());

    // Then
    expect(selected).toBe(true);
  });

  it("compares repeated object references once", () => {
    // Given
    const expected = { label: "shared" };
    const value = { label: "shared" };
    const schema = {
      const: { first: expected, second: expected },
    } satisfies ToolInputSchema;

    // When
    const selected = selectSchemaVariant(
      [schema, true],
      { first: value, second: value },
      new Set()
    );

    // Then
    expect(selected).toBe(schema);
  });

  it("matches enum entries and rejects values outside the enum", () => {
    // Given
    const schema = {
      enum: ["first", { kind: "second" }],
    } satisfies ToolInputSchema;

    // When
    const selected = selectSchemaVariant(
      [schema, true],
      { kind: "second" },
      new Set()
    );
    const rejected = selectSchemaVariant([schema, true], "third", new Set());

    // Then
    expect(selected).toBe(schema);
    expect(rejected).toBe(true);
  });

  it("enforces required and declared property schemas", () => {
    // Given
    const schema = {
      type: "object",
      properties: {
        allowed: { type: "string" },
        denied: false,
      },
      required: ["allowed"],
    } satisfies ToolInputSchema;

    // When
    const selected = selectSchemaVariant(
      [schema, true],
      { allowed: "value" },
      new Set()
    );
    const missing = selectSchemaVariant([schema, true], {}, new Set());
    const wrongType = selectSchemaVariant(
      [schema, true],
      { allowed: 1 },
      new Set()
    );
    const denied = selectSchemaVariant(
      [schema, true],
      { allowed: "value", denied: true },
      new Set()
    );
    const primitive = selectSchemaVariant(
      [{ required: ["allowed"] }, true],
      "value",
      new Set()
    );

    // Then
    expect(selected).toBe(schema);
    expect(missing).toBe(true);
    expect(wrongType).toBe(true);
    expect(denied).toBe(true);
    expect(primitive).toBe(true);
  });

  it("enforces matching pattern property schemas", () => {
    // Given
    const schema = {
      patternProperties: {
        "^x-": { type: "string" },
        label$: { minLength: 1 },
      },
    } satisfies ToolInputSchema;

    // When
    const selected = selectSchemaVariant(
      [schema, true],
      { "x-label": "value", ignored: 1 },
      new Set()
    );
    const rejected = selectSchemaVariant(
      [schema, true],
      { "x-label": 1 },
      new Set()
    );

    // Then
    expect(selected).toBe(schema);
    expect(rejected).toBe(true);
  });

  it("combines allOf anyOf and oneOf matches", () => {
    // Given
    const schema: ToolInputSchema = {
      allOf: [{ type: "object" }, { required: ["kind"] }],
      anyOf: [{ properties: { kind: { const: "first" } } }, false],
      oneOf: [
        { properties: { kind: { type: "string" } } },
        { properties: { count: { type: "number" } }, required: ["count"] },
      ],
    };

    // When
    const selected = selectSchemaVariant(
      [schema, true],
      { kind: "first" },
      new Set()
    );
    const rejectedAll = selectSchemaVariant(
      [schema, true],
      { kind: "first", count: 1 },
      new Set()
    );
    const rejectedAny = selectSchemaVariant(
      [schema, true],
      { kind: "other" },
      new Set()
    );

    // Then
    expect(selected).toBe(schema);
    expect(rejectedAll).toBe(true);
    expect(rejectedAny).toBe(true);
  });

  it("handles empty combinators according to their boolean identities", () => {
    // Given
    const all = { allOf: [] } satisfies ToolInputSchema;
    const any = { anyOf: [] } satisfies ToolInputSchema;
    const one = { oneOf: [] } satisfies ToolInputSchema;

    // When
    const selectedAll = selectSchemaVariant([all, true], "value", new Set());
    const rejectedAny = selectSchemaVariant([any, true], "value", new Set());
    const rejectedOne = selectSchemaVariant([one, true], "value", new Set());

    // Then
    expect(selectedAll).toBe(all);
    expect(rejectedAny).toBe(true);
    expect(rejectedOne).toBe(true);
  });

  it("terminates cyclic property schema evaluation through the seen set", () => {
    // Given
    const schema: ToolInputSchema = { type: "object", properties: {} };
    schema.properties = { self: schema };

    // When
    const selected = selectSchemaVariant(
      [schema, true],
      { self: {} },
      new Set()
    );
    const preSeen = selectSchemaVariant(
      [schema, true],
      { self: {} },
      new Set([schema])
    );

    // Then
    expect(selected).toBe(schema);
    expect(preSeen).toBe(schema);
  });

  it("scores declared pattern and strict additional properties", () => {
    // Given
    const generic = { properties: { common: true } } satisfies ToolInputSchema;
    const pattern = {
      patternProperties: { "^x-": true },
    } satisfies ToolInputSchema;
    const strict = {
      properties: { common: true, exact: true },
      additionalProperties: false,
    } satisfies ToolInputSchema;

    // When
    const patternSelected = selectSchemaVariant(
      [generic, pattern],
      { "x-label": "value" },
      new Set()
    );
    const strictSelected = selectSchemaVariant(
      [generic, strict],
      { common: true, exact: true },
      new Set()
    );
    const genericSelected = selectSchemaVariant(
      [strict, generic],
      { common: true, extra: true },
      new Set()
    );

    // Then
    expect(patternSelected).toBe(pattern);
    expect(strictSelected).toBe(strict);
    expect(genericSelected).toBe(generic);
  });

  it("falls back to the highest positive score when no variant accepts", () => {
    // Given
    const unscored = { type: "number" } satisfies ToolInputSchema;
    const scored = {
      type: "number",
      properties: { preferred: true },
    } satisfies ToolInputSchema;

    // When
    const selected = selectSchemaVariant(
      [unscored, scored],
      { preferred: true },
      new Set()
    );

    // Then
    expect(selected).toBe(scored);
  });

  it("unwraps jsonSchema containers during matching and scoring", () => {
    // Given
    const wrapped = {
      jsonSchema: {
        type: "object",
        properties: { wrapped: { const: true } },
      },
    } satisfies ToolInputSchema;
    const direct = {
      type: "object",
      properties: { direct: true },
    } satisfies ToolInputSchema;

    // When
    const selected = selectSchemaVariant(
      [direct, wrapped],
      { wrapped: true },
      new Set()
    );

    // Then
    expect(selected).toBe(wrapped);
  });
});
