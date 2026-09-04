import type { JSONObject, JSONValue } from "@ai-sdk/provider";
import { describe, expect, expectTypeOf, it } from "vitest";
import { argumentValueMatchesSchemaKeyShape } from "../../../core/protocols/hermes-argument-schema";
import type {
  ToolInputSchema,
  ToolInputSchemaDefinition,
} from "../../../schema/tool-input-schema";

type DateIsHermesArgument = Date extends JSONValue | undefined ? true : false;
type FunctionIsHermesArgument = (() => void) extends JSONValue | undefined
  ? true
  : false;

describe("argumentValueMatchesSchemaKeyShape", () => {
  it("validates reused array item references against each item schema", () => {
    const shared = { value: "text" };
    const itemTypes = ["string", "number"] as const;
    const schema: ToolInputSchemaDefinition = {
      type: "array",
      prefixItems: itemTypes.map((type) => ({
        type: "object",
        properties: { value: { type } },
        required: ["value"],
        additionalProperties: false,
      })),
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
    const schema: ToolInputSchemaDefinition = {
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
    const schema: ToolInputSchemaDefinition = {
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

  it("fails closed without overflowing on cyclic and deeply nested values", () => {
    expectTypeOf<DateIsHermesArgument>().toEqualTypeOf<false>();
    expectTypeOf<FunctionIsHermesArgument>().toEqualTypeOf<false>();

    const cyclicValue: JSONObject = {};
    cyclicValue.nested = cyclicValue;
    expect(
      argumentValueMatchesSchemaKeyShape(
        cyclicValue,
        { type: "object", additionalProperties: true },
        new Set(),
        true
      )
    ).toBe(false);

    // Live-cyclic schema: additionalProperties references the schema object
    // itself. The value-graph `seen` guard never fires (every value node is a
    // distinct object), so recursion depth follows the value, not the schema.
    const cyclicSchema: ToolInputSchema = {
      type: "object",
      additionalProperties: {},
    };
    cyclicSchema.additionalProperties = cyclicSchema;

    // Nest far beyond MAX_ARGUMENT_SHAPE_DEPTH (256). Without the depth guard
    // this overflows the stack (RangeError); with it, validation stops at the
    // cap and fails closed.
    let deepValue: JSONObject = {};
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
