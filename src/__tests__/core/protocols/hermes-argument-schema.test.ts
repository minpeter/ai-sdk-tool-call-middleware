import { describe, expect, it } from "vitest";
import { argumentValueMatchesSchemaKeyShape } from "../../../core/protocols/hermes-argument-schema";

describe("argumentValueMatchesSchemaKeyShape", () => {
  it("validates reused array item references against each item schema", () => {
    const shared = { value: "text" };
    const schema = {
      type: "array",
      prefixItems: [
        {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
      ],
    };

    expect(
      argumentValueMatchesSchemaKeyShape(
        [shared, shared],
        schema,
        new Set(),
        true
      )
    ).toBe(false);
  });

  it("accepts unconstrained unsafe pattern schemas when unknown keys are allowed", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(a+)+$": {},
      },
      additionalProperties: true,
    };

    expect(
      argumentValueMatchesSchemaKeyShape(
        { aaaa: "ok" },
        schema,
        new Set(),
        true
      )
    ).toBe(true);
  });

  it("rejects constrained unsafe pattern schemas that may match a key", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(a+)+$": { type: "string", enum: ["allowed"] },
      },
      additionalProperties: true,
    };

    expect(
      argumentValueMatchesSchemaKeyShape({ aaaa: 123 }, schema, new Set(), true)
    ).toBe(false);
  });

  it("fails closed without overflowing on a recursive schema and a deeply nested value", () => {
    // Live-cyclic schema: additionalProperties references the schema object
    // itself. The value-graph `seen` guard never fires (every value node is a
    // distinct object), so recursion depth follows the value, not the schema.
    const cyclicSchema: Record<string, unknown> = {
      type: "object",
      additionalProperties: {},
    };
    cyclicSchema.additionalProperties = cyclicSchema;

    // Nest far beyond MAX_ARGUMENT_SHAPE_DEPTH (256). Without the depth guard
    // this overflows the stack (RangeError); with it, validation stops at the
    // cap and fails closed.
    let deepValue: Record<string, unknown> = {};
    for (let index = 0; index < 5000; index += 1) {
      deepValue = { nested: deepValue };
    }

    let result: boolean | undefined;
    expect(() => {
      result = argumentValueMatchesSchemaKeyShape(
        deepValue,
        cyclicSchema,
        new Set(),
        true
      );
    }).not.toThrow();
    expect(result).toBe(false);
  });
});
