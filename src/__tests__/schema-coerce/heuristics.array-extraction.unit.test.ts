import {
  isJSONArray,
  isJSONObject,
  type JSONSchema7,
  type JSONValue,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

interface ExtractionCase {
  readonly expected: JSONValue[];
  readonly input: JSONValue;
  readonly itemType?: "number" | "string";
  readonly name: string;
  readonly schema: JSONSchema7;
}

const arrayExtractionCases: readonly ExtractionCase[] = [
  {
    name: "should extract array from single key object",
    input: { number: ["3", "5", "7"] },
    schema: { type: "array", items: { type: "number" } },
    expected: [3, 5, 7],
    itemType: "number",
  },
  {
    name: "should extract string array from single key object",
    input: { color: ["red", "green", "blue"] },
    schema: { type: "array", items: { type: "string" } },
    expected: ["red", "green", "blue"],
    itemType: "string",
  },
  {
    name: "should handle mixed type single key extraction",
    input: { value: ["123", "hello", "45.67", "true"] },
    schema: { type: "array", items: { type: "string" } },
    expected: ["123", "hello", "45.67", "true"],
  },
  {
    name: "should unwrap primitive wrapper objects for array item schemas",
    input: { to: { element: "legal@corp.com" } },
    schema: { type: "array", items: { type: "string" } },
    expected: ["legal@corp.com"],
  },
  {
    name: "should coerce primitive wrapper object values by item schema type",
    input: { number: { value: "42" } },
    schema: { type: "array", items: { type: "integer" } },
    expected: [42],
  },
  {
    name: "should keep object value when primitive wrapper coercion is not possible",
    input: { payload: { value: { nested: "x" } } },
    schema: { type: "array", items: { type: "string" } },
    expected: [{ value: { nested: "x" } }],
  },
  {
    name: "should unwrap wrapped primitive objects inside arrays",
    input: [{ element: "legal@corp.com" }],
    schema: { type: "array", items: { type: "string" } },
    expected: ["legal@corp.com"],
  },
  {
    name: "should unwrap wrapped primitive objects for tags array",
    input: [{ tag: "refund" }],
    schema: { type: "array", items: { type: "string" } },
    expected: ["refund"],
  },
  {
    name: "should not unwrap single key objects when items schema expects that key",
    input: { user: { name: "Alice" } },
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: { name: { type: "string" } },
          },
        },
        required: ["user"],
      },
    },
    expected: [{ user: { name: "Alice" } }],
  },
  {
    name: "should not unwrap single key objects when items schema allows additionalProperties",
    input: { foo: { bar: "1" } },
    schema: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { bar: { type: "string" } },
        },
      },
    },
    expected: [{ foo: { bar: "1" } }],
  },
  {
    name: "should not unwrap single key objects when items schema has implicit additionalProperties",
    input: { user: { name: "Alice" } },
    schema: { type: "array", items: { type: "object" } },
    expected: [{ user: { name: "Alice" } }],
  },
  {
    name: "should not unwrap single key objects when items schema uses patternProperties",
    input: { foo: { bar: "1" } },
    schema: {
      type: "array",
      items: {
        type: "object",
        patternProperties: {
          "^f": {
            type: "object",
            properties: { bar: { type: "string" } },
          },
        },
      },
    },
    expected: [{ foo: { bar: "1" } }],
  },
  {
    name: "should unwrap single key objects when patternProperties do not match and additionalProperties is false",
    input: { wrapper: { "x-id": "1" } },
    schema: {
      type: "array",
      items: {
        type: "object",
        patternProperties: { "^x-": { type: "string" } },
        additionalProperties: false,
      },
    },
    expected: [{ "x-id": "1" }],
  },
  {
    name: "should unwrap single key objects when patternProperties explicitly disallow the key",
    input: { wrapper: { id: "1" } },
    schema: {
      type: "array",
      items: {
        type: "object",
        patternProperties: { "^wrapper$": false },
        additionalProperties: true,
      },
    },
    expected: [{ id: "1" }],
  },
  {
    name: "should unwrap single key objects when allOf disallows the wrapper key",
    input: { wrapper: { id: "1" } },
    schema: {
      type: "array",
      items: {
        allOf: [
          {
            type: "object",
            properties: { id: { type: "string" } },
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              wrapper: {
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
          },
        ],
      },
    },
    expected: [{ id: "1" }],
  },
];

function coerceArray(input: JSONValue, schema: JSONSchema7): JSONValue[] {
  const result = coerceBySchema(input, schema);
  if (!isJSONArray(result)) {
    throw new TypeError("Expected array coercion result");
  }
  return result;
}

function registerCases(cases: readonly ExtractionCase[]): void {
  for (const { name, input, schema, expected, itemType } of cases) {
    it(name, () => {
      const result = coerceArray(input, schema);
      expect(result).toEqual(expected);
      if (itemType !== undefined) {
        expect(result.every((item) => typeof item === itemType)).toBe(true);
      }
    });
  }
}

describe("Coercion Heuristic Handling", () => {
  describe("Single key array extraction", () => {
    registerCases(arrayExtractionCases.slice(0, 8));

    it("should extract object from single key (single/multiple element consistency)", () => {
      const schema: JSONSchema7 = {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" } },
          additionalProperties: false,
        },
      };

      const singleResult = coerceArray({ user: { name: "Alice" } }, schema);
      const multiResult = coerceArray(
        { user: [{ name: "Alice" }, { name: "Bob" }] },
        schema
      );
      expect(singleResult).toEqual([{ name: "Alice" }]);
      expect(multiResult).toEqual([{ name: "Alice" }, { name: "Bob" }]);
    });

    registerCases(arrayExtractionCases.slice(8));

    it("should handle nested single key object extraction", () => {
      const input = { wrapper: { items: { id: "1", value: "test" } } };
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          wrapper: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                value: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        },
      };

      const result = coerceBySchema(input, schema);
      expect(isJSONObject(result) ? result.wrapper : result).toEqual([
        { id: "1", value: "test" },
      ]);
    });

    it("should wrap multiple key objects in array when not extractable", () => {
      const input = { number: ["3", "5"], color: ["red", "blue"] };
      const schema: JSONSchema7 = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceArray(input, schema);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(input);
    });
  });
});
