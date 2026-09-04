import {
  isJSONArray,
  type JSONSchema7,
  type JSONValue,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

interface NumericKeyCase {
  readonly expected: JSONValue[];
  readonly expectedItemType?: "number";
  readonly input: JSONValue;
  readonly name: string;
  readonly schema: JSONSchema7;
}

const numericKeyCases: readonly NumericKeyCase[] = [
  {
    name: "should convert numeric keys to array",
    input: { "0": "first", "1": "second", "2": "third" },
    schema: { type: "array", items: { type: "string" } },
    expected: ["first", "second", "third"],
  },
  {
    name: "should handle numeric keys with number coercion",
    input: { "0": "10.5", "1": "20.3", "2": "15.8" },
    schema: { type: "array", items: { type: "number" } },
    expected: [10.5, 20.3, 15.8],
    expectedItemType: "number",
  },
  {
    name: "should handle non-consecutive numeric keys",
    input: { "0": "first", "2": "third", "5": "sixth" },
    schema: { type: "array", items: { type: "string" } },
    expected: ["first", "third", "sixth"],
  },
];

describe("Coercion Heuristic Handling", () => {
  describe("Numeric key handling", () => {
    for (const {
      name,
      input,
      schema,
      expected,
      expectedItemType,
    } of numericKeyCases) {
      it(name, () => {
        const result = coerceBySchema(input, schema);
        if (!isJSONArray(result)) {
          throw new TypeError("Expected numeric-key array result");
        }
        expect(result).toEqual(expected);
        if (expectedItemType !== undefined) {
          expect(result.every((item) => typeof item === expectedItemType)).toBe(
            true
          );
        }
      });
    }

    it("should wrap mixed key type objects in array", () => {
      const input = { "0": "zero", name: "test" };
      const schema: JSONSchema7 = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema);
      expect(result).toEqual([input]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      if (!isJSONArray(result)) {
        throw new TypeError("Expected mixed-key wrapping result");
      }
      expect(result.at(0)).toEqual(input);
    });
  });
});
