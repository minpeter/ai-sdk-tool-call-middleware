import { describe, expect, it } from "vitest";
import {
  coerceBySchema,
  compileSafePatternPropertyRegex,
  getSchemaType,
  schemaIsUnconstrained,
  unwrapJsonSchema,
} from "../../schema-coerce";

describe("schema coercion exported and edge paths", () => {
  it("covers exported schema helpers and boolean schemas", () => {
    expect(unwrapJsonSchema({ type: "string" })).toEqual({ type: "string" });
    expect(getSchemaType({ type: "integer" })).toBe("integer");
    expect(schemaIsUnconstrained(true)).toBe(true);
    expect(compileSafePatternPropertyRegex("^")).toBeInstanceOf(RegExp);
    expect(coerceBySchema("true", true)).toBe(true);
    expect(coerceBySchema(7, false)).toBe(7);
  });

  it("covers schema-free scalar, JSON fallback, and malformed fallback paths", () => {
    expect(coerceBySchema(" true ")).toBe(true);
    expect(coerceBySchema("false")).toBe(false);
    expect(coerceBySchema("12.5e2")).toBe(1250);
    expect(coerceBySchema("1e400")).toBe("1e400");
    expect(coerceBySchema('{"n":"2"}')).toEqual({ n: "2" });
    expect(coerceBySchema('["2"]')).toEqual(["2"]);
    expect(coerceBySchema("{malformed}")).toBe("{malformed}");
    expect(coerceBySchema("[malformed]")).toBe("[malformed]");
  });

  it("covers string object and array parser fallback branches", () => {
    expect(coerceBySchema("not an object", { type: "object" })).toBe(
      "not an object"
    );
    expect(
      coerceBySchema("1, 2", { type: "array", items: { type: "number" } })
    ).toEqual([1, 2]);
    expect(
      coerceBySchema("1\n2", { type: "array", items: { type: "number" } })
    ).toEqual([1, 2]);
    expect(
      coerceBySchema("['1', '2']", { type: "array", items: { type: "number" } })
    ).toEqual([1, 2]);
    expect(
      coerceBySchema("['1']", {
        type: "array",
        prefixItems: [{ type: "number" }],
      })
    ).toEqual([1]);
    expect(
      coerceBySchema("{bad", { type: "array", items: { type: "string" } })
    ).toEqual(["{bad"]);
    expect(
      coerceBySchema('["2"]', { type: "array", items: { type: "number" } })
    ).toEqual([2]);
    expect(
      coerceBySchema("{}", { type: "array", items: { type: "string" } })
    ).toBe("{}");
    expect(
      coerceBySchema("true, 7", {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "string" }],
      })
    ).toEqual(["true", "7"]);
  });

  it("covers object property schema combinations", () => {
    expect(
      coerceBySchema(
        { known: "1", skipped: "2", extra: "3" },
        {
          type: "object",
          properties: { known: { type: "number" }, skipped: true },
          patternProperties: { "^s": false },
          additionalProperties: { type: "number" },
        }
      )
    ).toEqual({ known: 1, skipped: "2", extra: 3 });
    expect(
      coerceBySchema(
        { value: "2" },
        { type: "object", additionalProperties: false }
      )
    ).toEqual({ value: "2" });
    expect(coerceBySchema({ value: "2" }, { type: "object" })).toEqual({
      value: 2,
    });
  });

  it("covers array object forms and parallel-array rejection branches", () => {
    const item = {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    };
    expect(
      coerceBySchema(
        { "0": "a", "1": "b" },
        { type: "array", items: { type: "string" } }
      )
    ).toEqual(["a", "b"]);
    expect(
      coerceBySchema(
        { a: ["1"], b: ["2", "3"] },
        { type: "array", items: item }
      )
    ).toEqual([{ a: ["1"], b: ["2", "3"] }]);
    expect(
      coerceBySchema({ a: ["1"], b: "2" }, { type: "array", items: item })
    ).toEqual([{ a: ["1"], b: "2" }]);
    expect(
      coerceBySchema(
        { unknown: ["1"], other: ["2"] },
        { type: "array", items: item }
      )
    ).toEqual([{ unknown: ["1"], other: ["2"] }]);
    expect(
      coerceBySchema(
        { value: ["1"], other: ["2"] },
        { type: "array", items: item }
      )
    ).toEqual([{ value: ["1"], other: ["2"] }]);
    expect(
      coerceBySchema({ value: ["1", "2"] }, { type: "array", items: item })
    ).toEqual([{ value: ["1", "2"] }]);
    const strictPair = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      additionalProperties: false,
    };
    expect(
      coerceBySchema(
        { a: ["1"], b: ["2", "3"] },
        { type: "array", items: strictPair }
      )
    ).toEqual([{ a: ["1"], b: ["2", "3"] }]);
    expect(
      coerceBySchema(
        { a: ["1"], b: ["2"] },
        { type: "array", items: strictPair }
      )
    ).toEqual([{ a: ["1"], b: ["2"] }]);
    expect(
      coerceBySchema(
        { wrapper: { a: 1, b: 2 } },
        { type: "array", items: { type: "string" } }
      )
    ).toEqual([{ a: 1, b: 2 }]);
    expect(
      coerceBySchema(
        { wrapper: { value: true } },
        { type: "array", items: { type: "number" } }
      )
    ).toEqual([{ value: true }]);
    expect(
      coerceBySchema(
        { wrapper: null },
        {
          type: "array",
          items: { type: "object", properties: { x: { type: "string" } } },
        }
      )
    ).toEqual([{ wrapper: null }]);
    expect(
      coerceBySchema(
        { wrapper: 1 },
        {
          type: "array",
          items: {
            type: "object",
            properties: { x: { type: "string" } },
            additionalProperties: false,
          },
        }
      )
    ).toEqual([{ wrapper: 1 }]);
    expect(
      coerceBySchema(
        { wrapper: { x: "1" } },
        {
          type: "array",
          items: {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
            additionalProperties: false,
          },
        }
      )
    ).toEqual([{ x: "1" }]);
    expect(
      coerceBySchema(
        { value: { x: "1" } },
        {
          type: "array",
          items: { type: "object", properties: { value: { type: "string" } } },
        }
      )
    ).toEqual([{ value: "1" }]);
    expect(
      coerceBySchema(
        { a: ["1"], b: ["2"] },
        { type: "array", prefixItems: [{ type: "string" }], items: item }
      )
    ).toEqual([{ a: ["1"], b: ["2"] }]);
    expect(
      coerceBySchema(
        { a: ["1"], b: ["2"] },
        { type: "array", items: { type: "array", items: { type: "string" } } }
      )
    ).toEqual([{ a: ["1"], b: ["2"] }]);
    expect(
      coerceBySchema(
        { a: ["1", "2"], b: ["3", "4"] },
        {
          type: "array",
          items: {
            type: "object",
            properties: { a: { type: "array" }, b: { type: "string" } },
            additionalProperties: false,
          },
        }
      )
    ).toEqual([{ a: [1, 2], b: ["3", "4"] }]);
  });
});
