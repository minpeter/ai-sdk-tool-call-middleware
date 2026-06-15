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
});
