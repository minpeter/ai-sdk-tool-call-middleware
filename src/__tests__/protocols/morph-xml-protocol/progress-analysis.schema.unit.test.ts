import { describe, expect, it } from "vitest";
import {
  getObjectSchemaPropertyNames,
  getObjectSchemaStringPropertyNames,
  getSchemaObjectProperty,
  isStrictStringSchemaProperty,
  schemaAllowsArrayType,
} from "../../../core/protocols/morph-xml-progress-analysis";
import {
  isSchemaDefinition,
  type ToolInputSchema,
  type ToolInputSchemaCandidate,
} from "../../../schema/tool-input-schema";

describe("morph XML progress schema analysis", () => {
  it("extracts own property names only from object-compatible schemas", () => {
    const inheritedProperties = Object.create({
      inherited: { type: "string" },
    });
    inheritedProperties.own = { type: "string" };
    const schemas: ToolInputSchema[] = [
      { type: "object", properties: { value: { type: "string" } } },
      { type: ["null", "object"], properties: inheritedProperties },
      { properties: {} },
      { type: "string", properties: { ignored: { type: "string" } } },
    ];

    const results = schemas.map((schema) =>
      getObjectSchemaPropertyNames(schema)
    );

    expect(results.map((result) => (result ? [...result] : null))).toEqual([
      ["value"],
      ["own"],
      [],
      null,
    ]);
    expect(getObjectSchemaPropertyNames(schemas[0])).toBe(results[0]);
    const malformedSchema: ToolInputSchemaCandidate = { properties: false };
    expect(
      isSchemaDefinition(malformedSchema)
        ? getObjectSchemaPropertyNames(malformedSchema)
        : null
    ).toEqual(new Set());
    expect(getObjectSchemaPropertyNames(false)).toBeNull();
  });

  it("recognizes direct, tuple, wrapped, and union array schemas", () => {
    const schemas: ToolInputSchema[] = [
      { type: "array" },
      { type: ["null", "array"] },
      { jsonSchema: { type: "array" } },
      { anyOf: [{ type: "string" }, { type: "array" }] },
      { oneOf: [{ type: "array" }] },
      { allOf: [{ type: "array" }] },
    ];

    const results = schemas.map(schemaAllowsArrayType);

    expect(results).toEqual([true, true, true, true, true, true]);
    expect(schemaAllowsArrayType(schemas[0])).toBe(true);
  });

  it("rejects primitive, malformed, and non-array schemas", () => {
    const schemas: ToolInputSchemaCandidate[] = [
      false,
      true,
      null,
      "array",
      { type: "string" },
      { anyOf: {} },
    ];

    const results = schemas.map((schema) =>
      isSchemaDefinition(schema) ? schemaAllowsArrayType(schema) : false
    );

    expect(results).toEqual([false, false, false, false, false, false]);
  });

  it("handles cyclic union schemas without overflowing", () => {
    const cyclicSchema: ToolInputSchema = {};
    cyclicSchema.anyOf = [cyclicSchema];

    const result = schemaAllowsArrayType(cyclicSchema);

    expect(result).toBe(false);
  });

  it("extracts string property names through direct and union schemas", () => {
    const sharedStringSchema: ToolInputSchema = { type: "string" };
    const schema: ToolInputSchema = {
      type: "object",
      properties: {
        direct: sharedStringSchema,
        shared: sharedStringSchema,
        tuple: { type: ["null", "string"] },
        any: { anyOf: [{ type: "number" }, { type: "string" }] },
        one: { oneOf: [{ type: "string" }] },
        all: { allOf: [{ type: "string" }] },
        number: { type: "number" },
        disabled: false,
      },
    };

    const first = getObjectSchemaStringPropertyNames(schema);
    const second = getObjectSchemaStringPropertyNames(schema);

    expect(first ? [...first] : null).toEqual([
      "direct",
      "shared",
      "tuple",
      "any",
      "one",
      "all",
    ]);
    expect(second).toBe(first);
    expect(getObjectSchemaStringPropertyNames(false)).toBeNull();
  });

  it("handles cyclic string union schemas without overflowing", () => {
    const cyclicProperty: ToolInputSchema = {};
    cyclicProperty.oneOf = [cyclicProperty];
    const schema: ToolInputSchema = { properties: { value: cyclicProperty } };

    const result = getObjectSchemaStringPropertyNames(schema);

    expect(result).toEqual(new Set());
  });

  it("reads only present schema properties", () => {
    const schema: ToolInputSchema = {
      properties: { present: { type: "string" }, disabled: false },
    };

    const results = [
      getSchemaObjectProperty(schema, "present"),
      getSchemaObjectProperty(schema, "missing"),
      getSchemaObjectProperty(schema, "disabled"),
      getSchemaObjectProperty(false, "present"),
      getSchemaObjectProperty({ additionalProperties: false }, "present"),
    ];

    expect(results).toEqual([{ type: "string" }, null, null, null, null]);
  });

  it("requires an exact string type for prefix-stable progress", () => {
    const schema: ToolInputSchema = {
      properties: {
        direct: { type: "string" },
        tuple: { type: ["string"] },
        mixed: { type: ["string", "null"] },
        wrapped: { jsonSchema: { type: "string" } },
        absent: false,
      },
    };

    const results = ["direct", "tuple", "mixed", "wrapped", "absent"].map(
      (name) => isStrictStringSchemaProperty(schema, name)
    );

    expect(results).toEqual([true, true, false, true, false]);
  });
});
