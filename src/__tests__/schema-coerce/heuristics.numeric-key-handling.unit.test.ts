import { describe, expect, it } from "vitest";
import { coerceBySchema } from "../../schema-coerce";

describe("Coercion Heuristic Handling", () => {
  describe("Numeric key handling", () => {
    it("should convert numeric keys to array", () => {
      const input = {
        "0": "first",
        "1": "second",
        "2": "third",
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["first", "second", "third"]);
    });

    it("should handle numeric keys with number coercion", () => {
      const input = {
        "0": "10.5",
        "1": "20.3",
        "2": "15.8",
      };

      const schema = {
        type: "array",
        items: { type: "number" },
      };

      const result = coerceBySchema(input, schema) as any;
      expect(result).toEqual([10.5, 20.3, 15.8]);
      const arr = result as any[];
      expect(arr.every((item: any) => typeof item === "number")).toBe(true);
    });

    it("should handle non-consecutive numeric keys", () => {
      const input = {
        "0": "first",
        "2": "third",
        "5": "sixth",
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      // Non-consecutive keys should still be converted but maintain order
      const result = coerceBySchema(input, schema) as any[];
      expect(result).toEqual(["first", "third", "sixth"]);
    });

    it("should wrap mixed key type objects in array", () => {
      const input = {
        "0": "zero",
        name: "test",
      };

      const schema = {
        type: "array",
        items: { type: "string" },
      };

      // Mixed keys should be wrapped in array
      const result = coerceBySchema(input, schema) as any[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(input);
    });
  });
});
