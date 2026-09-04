import type { JSONObject, JSONSchema7, JSONValue } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Complex nested scenarios", () => {
    it("should handle nested object with array extraction", () => {
      const input = {
        coordinates: {
          item: ["46.603354", "1.8883340"],
        },
        name: "test location",
      };

      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          coordinates: {
            type: "array",
            items: { type: "number" },
          },
          name: { type: "string" },
        },
      };

      const result = coerceBySchema(input, schema) as JSONObject;
      expect(result).toEqual({
        coordinates: [46.603_354, 1.888_334],
        name: "test location",
      });
      const obj = result;
      expect(
        (obj.coordinates as JSONValue[]).every(
          (item) => typeof item === "number"
        )
      ).toBe(true);
    });

    it("should handle array of objects with heuristic extraction", () => {
      const input = [{ item: ["1", "2"] }, { item: ["3", "4"] }];

      const schema: JSONSchema7 = {
        type: "array",
        items: {
          type: "array",
          items: { type: "number" },
        },
      };

      const result = coerceBySchema(input, schema) as JSONValue[][];
      expect(result).toEqual([
        [1, 2],
        [3, 4],
      ]);
      expect(
        result.every((arr) => arr.every((item) => typeof item === "number"))
      ).toBe(true);
    });
  });
});
